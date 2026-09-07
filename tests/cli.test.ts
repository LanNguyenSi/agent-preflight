/**
 * Tests for src/cli.ts
 *
 * Covers: option parsing, flag→config mapping, exit-code contract (0=ready, 1=not-ready),
 * and pretty-print branch output (status icon, blockers, warnings, limitations).
 *
 * Strategy: cli.ts exports createProgram() so each test can construct a FRESH
 * Command instance. Commander retains option state (e.g. --json) between
 * parseAsync calls on the same instance; sharing a singleton across tests
 * causes option leaks that silently route all calls through the JSON branch.
 * A fresh instance per test removes that leak.
 *
 * All heavy runners (runPreflight, runBatch, runSandbox) are mocked via vi.hoisted
 * so the factories capture the vi.fn() references before any static import runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreflightConfig, PreflightResult } from "../src/types.js";

// ── Stable mock references created before any imports ────────────────────────
const mockRunPreflight = vi.hoisted(() =>
  vi.fn<(repoPath: string, config: PreflightConfig) => Promise<PreflightResult>>()
);
const mockRunBatch = vi.hoisted(() => vi.fn());
const mockRunSandbox = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock("../src/runner.js", () => ({ runPreflight: mockRunPreflight }));
vi.mock("../src/batch.js", () => ({ runBatch: mockRunBatch }));
vi.mock("../src/sandbox.js", () => ({ runSandbox: mockRunSandbox }));
vi.mock("../src/config.js", () => ({ loadConfig: mockLoadConfig }));

// ── Import after mocks are registered ────────────────────────────────────────
import { createProgram, writeJsonAndExit } from "../src/cli.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    ready: true,
    confidence: 0.9,
    checks: [],
    blockers: [],
    warnings: [],
    limitations: [],
    durationMs: 42,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeNotReadyResult(): PreflightResult {
  return makeResult({
    ready: false,
    blockers: ["lint failed"],
    checks: [
      {
        name: "lint",
        kind: "lint",
        status: "fail",
        message: "lint failed",
        durationMs: 10,
        confidenceContribution: 0.3,
      },
    ],
  });
}

/**
 * Call a CLI command using a fresh per-test program instance and capture the
 * exit code and console.log output.
 *
 * Returns a promise that resolves once process.exit has been (or reliably
 * will not be) called.
 *
 * The `run --json` path (see `writeJsonAndExit` in src/cli.ts) calls
 * `process.exit` from inside a `process.stdout.write` callback, deferred
 * to flush the JSON payload before the process tears down (task 0089e6f5:
 * an immediate `process.exit` right after the write could truncate a
 * payload larger than the OS pipe buffer). That callback fires on a later
 * microtask, after this function's `parseAsync` call already resolves (the
 * action itself returns synchronously right after scheduling the write), so
 * `process.exit` is neither mocked to throw nor assumed to have run yet by
 * the time `parseAsync` settles: a couple of microtask turns are flushed
 * below before inspecting `capturedCode`. Every current process.exit call
 * site is the last statement in its branch, so a non-throwing mock never
 * lets unrelated code run past it.
 */
async function runCommand(args: string[]): Promise<{ exitCode: number | undefined; stdout: string }> {
  let capturedCode: number | undefined;
  const logLines: string[] = [];

  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    capturedCode = code;
    return undefined as never;
  }) as typeof process.exit);
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((...logArgs: unknown[]) => {
    logLines.push(logArgs.map(String).join(" "));
  });
  // Silences and short-circuits process.stdout.write (used by the --json
  // path via writeJsonAndExit) so the JSON payload never actually prints
  // during the test run, while still invoking the write callback
  // asynchronously the way a real pipe/TTY write would.
  const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    _chunk: unknown,
    encodingOrCallback?: unknown,
    maybeCallback?: unknown
  ) => {
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    if (typeof callback === "function") queueMicrotask(() => (callback as () => void)());
    return true;
  }) as typeof process.stdout.write);

  try {
    await localProgram.parseAsync(args, { from: "user" });
  } finally {
    // Flush enough microtask turns for a deferred writeJsonAndExit exit
    // call (write callback -> exitOnce -> process.exit) to have run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  }

  return { exitCode: capturedCode, stdout: logLines.join("\n") };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

// Fresh Command instance per test: prevents --json (and other option state)
// from leaking between parseAsync calls on a shared singleton.
let localProgram: ReturnType<typeof createProgram>;

beforeEach(() => {
  localProgram = createProgram();

  mockLoadConfig.mockReturnValue({
    checks: {
      gitState: true,
      lint: true,
      audit: true,
      secretDetection: true,
      ciSimulation: false,
    },
    setup: { enabled: false },
  });
  mockRunPreflight.mockResolvedValue(makeResult());
  mockRunBatch.mockResolvedValue({
    total: 1,
    ready: 1,
    notReady: 0,
    skipped: 0,
    results: [],
  });
  mockRunSandbox.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── EXIT-CODE CONTRACT ────────────────────────────────────────────────────────

describe("run command — exit-code contract", () => {
  it("exits 0 when result.ready is true", async () => {
    mockRunPreflight.mockResolvedValue(makeResult({ ready: true }));
    const { exitCode } = await runCommand(["run", "--json", "."]);
    expect(exitCode).toBe(0);
  });

  it("exits 1 when result.ready is false", async () => {
    mockRunPreflight.mockResolvedValue(makeNotReadyResult());
    const { exitCode } = await runCommand(["run", "--json", "."]);
    expect(exitCode).toBe(1);
  });

  it("exits 0 via pretty (non-json) path when ready", async () => {
    mockRunPreflight.mockResolvedValue(makeResult({ ready: true }));
    const { exitCode } = await runCommand(["run", "."]);
    expect(exitCode).toBe(0);
  });

  it("exits 1 via pretty path when not ready", async () => {
    mockRunPreflight.mockResolvedValue(makeNotReadyResult());
    const { exitCode } = await runCommand(["run", "."]);
    expect(exitCode).toBe(1);
  });
});

// ── PRETTY-PRINT BRANCH OUTPUT ────────────────────────────────────────────────

describe("run command — pretty-print output", () => {
  it("renders ready status icon and READY label", async () => {
    mockRunPreflight.mockResolvedValue(makeResult({ ready: true }));
    const { exitCode, stdout } = await runCommand(["run", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✅");
    expect(stdout).toContain("READY");
    expect(stdout).not.toContain("NOT READY");
  });

  it("renders not-ready status icon, NOT READY label, and blockers", async () => {
    mockRunPreflight.mockResolvedValue(makeNotReadyResult());
    const { exitCode, stdout } = await runCommand(["run", "."]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("❌");
    expect(stdout).toContain("NOT READY");
    expect(stdout).toContain("Blockers:");
    expect(stdout).toContain("lint failed");
  });

  it("renders warnings when present", async () => {
    mockRunPreflight.mockResolvedValue(makeResult({ ready: true, warnings: ["minor warning"] }));
    const { stdout } = await runCommand(["run", "."]);
    expect(stdout).toContain("Warnings:");
    expect(stdout).toContain("minor warning");
  });

  it("renders limitations when present", async () => {
    mockRunPreflight.mockResolvedValue(makeResult({ ready: true, limitations: ["no ci sim"] }));
    const { stdout } = await runCommand(["run", "."]);
    expect(stdout).toContain("Limitations");
    expect(stdout).toContain("no ci sim");
  });

  it("renders an acknowledged check's justification in the human output (agent-tasks b31065cc)", async () => {
    mockRunPreflight.mockResolvedValue(
      makeResult({
        ready: true,
        checks: [
          {
            name: "npm-test",
            kind: "test",
            status: "acknowledged",
            message: "npm test failed — acknowledged: install-sh suite is linux-only, CI covers it",
            durationMs: 10,
            confidenceContribution: 0.2,
          },
        ],
      })
    );
    const { stdout } = await runCommand(["run", "."]);
    expect(stdout).toContain("Acknowledged");
    expect(stdout).toContain("install-sh suite is linux-only, CI covers it");
  });
});

// ── FLAG → CONFIG MAPPING ────────────────────────────────────────────────────

describe("run command — flag→config mapping", () => {
  it("passes through default config when no flags given", async () => {
    await runCommand(["run", "."]);
    const [, config] = mockRunPreflight.mock.calls[0];
    // audit and secretDetection should be unchanged (truthy from loadConfig)
    expect(config.checks?.audit).not.toBe(false);
    expect(config.checks?.secretDetection).not.toBe(false);
  });

  it("--no-audit sets config.checks.audit = false", async () => {
    await runCommand(["run", "--no-audit", "."]);
    const [, config] = mockRunPreflight.mock.calls[0];
    expect(config.checks?.audit).toBe(false);
  });

  it("--no-secrets sets config.checks.secretDetection = false", async () => {
    await runCommand(["run", "--no-secrets", "."]);
    const [, config] = mockRunPreflight.mock.calls[0];
    expect(config.checks?.secretDetection).toBe(false);
  });

  it("--setup sets config.setup.enabled = true", async () => {
    await runCommand(["run", "--setup", "."]);
    const [, config] = mockRunPreflight.mock.calls[0];
    expect(config.setup?.enabled).toBe(true);
  });

  it("--ci-simulation sets config.checks.ciSimulation = true", async () => {
    await runCommand(["run", "--ci-simulation", "."]);
    const [, config] = mockRunPreflight.mock.calls[0];
    expect(config.checks?.ciSimulation).toBe(true);
  });

  it("multiple flags combine correctly", async () => {
    await runCommand(["run", "--no-audit", "--no-secrets", "--setup", "--ci-simulation", "."]);
    const [, config] = mockRunPreflight.mock.calls[0];
    expect(config.checks?.audit).toBe(false);
    expect(config.checks?.secretDetection).toBe(false);
    expect(config.setup?.enabled).toBe(true);
    expect(config.checks?.ciSimulation).toBe(true);
  });
});

// ── BATCH COMMAND ─────────────────────────────────────────────────────────────

describe("batch command — exit-code contract", () => {
  it("exits 0 when all repos are ready", async () => {
    mockRunBatch.mockResolvedValue({ total: 2, ready: 2, notReady: 0, skipped: 0, results: [] });
    const { exitCode } = await runCommand(["batch", "--json", "."]);
    expect(exitCode).toBe(0);
  });

  it("exits 1 when some repos are not ready", async () => {
    mockRunBatch.mockResolvedValue({ total: 2, ready: 1, notReady: 1, skipped: 0, results: [] });
    const { exitCode } = await runCommand(["batch", "--json", "."]);
    expect(exitCode).toBe(1);
  });

  it("exits 0 via pretty batch output when all ready", async () => {
    mockRunBatch.mockResolvedValue({ total: 1, ready: 1, notReady: 0, skipped: 0, results: [] });
    const { exitCode } = await runCommand(["batch", "."]);
    expect(exitCode).toBe(0);
  });
});

describe("batch command — pretty output acknowledged marker (review finding 3)", () => {
  it("shows an '[n acknowledged]' marker on a repo's line when it has acknowledged checks", async () => {
    mockRunBatch.mockResolvedValue({
      total: 1,
      ready: 1,
      notReady: 0,
      skipped: 0,
      results: [
        {
          repo: "some-repo",
          result: makeResult({
            ready: true,
            checks: [
              {
                name: "npm-test",
                kind: "test",
                status: "acknowledged",
                message: "npm test failed — acknowledged: linux-only suite",
                durationMs: 10,
                confidenceContribution: 0.2,
              },
            ],
          }),
        },
      ],
    });

    const { stdout } = await runCommand(["batch", "."]);

    expect(stdout).toContain("[1 acknowledged]");
  });

  it("omits the marker when no check is acknowledged", async () => {
    mockRunBatch.mockResolvedValue({
      total: 1,
      ready: 1,
      notReady: 0,
      skipped: 0,
      results: [{ repo: "some-repo", result: makeResult({ ready: true }) }],
    });

    const { stdout } = await runCommand(["batch", "."]);

    expect(stdout).not.toContain("acknowledged");
  });
});

describe("batch command — flag→config mapping", () => {
  it("--no-audit sets configOverride.checks.audit = false", async () => {
    mockRunBatch.mockResolvedValue({ total: 0, ready: 0, notReady: 0, skipped: 0, results: [] });
    await runCommand(["batch", "--json", "--no-audit", "."]);
    const [, , configOverride] = mockRunBatch.mock.calls[0];
    expect(configOverride.checks?.audit).toBe(false);
  });

  it("--no-secrets sets configOverride.checks.secretDetection = false", async () => {
    mockRunBatch.mockResolvedValue({ total: 0, ready: 0, notReady: 0, skipped: 0, results: [] });
    await runCommand(["batch", "--json", "--no-secrets", "."]);
    const [, , configOverride] = mockRunBatch.mock.calls[0];
    expect(configOverride.checks?.secretDetection).toBe(false);
  });

  it("--setup sets configOverride.setup.enabled = true", async () => {
    mockRunBatch.mockResolvedValue({ total: 0, ready: 0, notReady: 0, skipped: 0, results: [] });
    await runCommand(["batch", "--json", "--setup", "."]);
    const [, , configOverride] = mockRunBatch.mock.calls[0];
    expect(configOverride.setup?.enabled).toBe(true);
  });
});

// ── SANDBOX COMMAND ───────────────────────────────────────────────────────────

describe("sandbox command", () => {
  it("delegates to runSandbox with the given options", async () => {
    await runCommand(["sandbox", "--print", "--json", "."]);
    expect(mockRunSandbox).toHaveBeenCalledOnce();
    const [repoPath, opts] = mockRunSandbox.mock.calls[0];
    expect(repoPath).toBe(".");
    expect(opts.print).toBe(true);
    expect(opts.json).toBe(true);
  });
});

// ── writeJsonAndExit: EPIPE handling (task 0089e6f5) ──────────────────────────
//
// `run --json`'s exit path now waits for the stdout write callback before
// exiting (see the docblock on writeJsonAndExit in src/cli.ts), so that a
// payload larger than the OS pipe buffer is fully flushed before the process
// tears down. That write can itself fail with EPIPE when the reader on the
// other end of the pipe closes early (e.g. `preflight run --json | head -c
// 100`); Node has no default handler for a stream 'error' event, so an
// unhandled EPIPE would otherwise crash the process with a non-deterministic
// exit code instead of the one the CLI's own ready/not-ready contract
// intends. These tests exercise writeJsonAndExit directly against a mocked
// process.stdout, since reproducing a real EPIPE through an actual OS pipe
// is a race that this repo's own sandboxed test runner cannot reliably force
// (see the implementer's report for task 0089e6f5 for what was tried).
describe("writeJsonAndExit: EPIPE handling", () => {
  it("exits with the intended code when the write fails with EPIPE, instead of crashing or swallowing it", () => {
    let capturedCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      capturedCode = code;
      return undefined as never;
    }) as typeof process.exit);
    // Simulates a reader that closed the pipe before the payload was fully
    // written: the write never calls its success callback, only the stream's
    // 'error' event fires (Node's real EPIPE behavior for a broken pipe).
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);

    const errorListenersBefore = process.stdout.listeners("error");
    try {
      writeJsonAndExit({ ready: false }, 1);
      const epipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      process.stdout.emit("error", epipeError);

      expect(capturedCode).toBe(1);
    } finally {
      // writeJsonAndExit registers a fresh "error" listener on the real,
      // shared process.stdout on every call; remove exactly the one this
      // test added so repeated runs don't accumulate listeners on the
      // process-wide stream.
      const addedListeners = process.stdout.listeners("error").filter((l) => !errorListenersBefore.includes(l));
      addedListeners.forEach((l) => process.stdout.removeListener("error", l as (...args: unknown[]) => void));
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("still exits with the intended code on a normal, fully-flushed write", async () => {
    let capturedCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      capturedCode = code;
      return undefined as never;
    }) as typeof process.exit);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: unknown,
      maybeCallback?: unknown
    ) => {
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      if (typeof callback === "function") queueMicrotask(() => (callback as () => void)());
      return true;
    }) as typeof process.stdout.write);

    try {
      writeJsonAndExit({ ready: true }, 0);
      await Promise.resolve();
      await Promise.resolve();
      expect(capturedCode).toBe(0);
    } finally {
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
