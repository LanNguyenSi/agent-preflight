/**
 * Tests for src/cli.ts
 *
 * Covers: option parsing, flag→config mapping, exit-code contract (0=ready, 1=not-ready).
 *
 * Strategy: cli.ts guards auto-execution with `require.main === module`, which is
 * false when imported by vitest (vitest itself is the main module). So we import
 * `program` directly and call `program.parseAsync(args, { from: 'user' })` per test.
 * All heavy runners (runPreflight, runBatch, runSandbox) are mocked via vi.hoisted
 * so the factories capture the vi.fn() references before any static import runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreflightResult } from "../src/types.js";

// ── Stable mock references created before any imports ────────────────────────
const mockRunPreflight = vi.hoisted(() => vi.fn<[], Promise<PreflightResult>>());
const mockRunBatch = vi.hoisted(() => vi.fn());
const mockRunSandbox = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock("../src/runner.js", () => ({ runPreflight: mockRunPreflight }));
vi.mock("../src/batch.js", () => ({ runBatch: mockRunBatch }));
vi.mock("../src/sandbox.js", () => ({ runSandbox: mockRunSandbox }));
vi.mock("../src/config.js", () => ({ loadConfig: mockLoadConfig }));

// ── Import after mocks are registered ────────────────────────────────────────
import { program } from "../src/cli.js";

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
 * Call a CLI command and capture the exit code.
 * Returns a promise that resolves when process.exit is called.
 */
async function runCommand(args: string[]): Promise<{ exitCode: number | undefined }> {
  let capturedCode: number | undefined;

  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    capturedCode = code as number;
    // Throw to stop execution immediately after process.exit is called
    throw new ExitSignal(code as number);
  });

  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    exitSpy.mockRestore();
  }

  return { exitCode: capturedCode };
}

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
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
