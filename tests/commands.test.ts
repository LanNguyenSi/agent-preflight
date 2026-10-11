import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import * as execaModule from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, mergeConfig, validateConfig } from "../src/config.js";
import { npmAuditRunner, runAuditChecks } from "../src/checks/audit.js";
import { runLintChecks } from "../src/checks/lint.js";
import { runTestChecks } from "../src/checks/test.js";
import { runTypecheckChecks } from "../src/checks/typecheck.js";
import * as shared from "../src/checks/shared.js";
import { shouldSkipRecursiveNodeTest } from "../src/checks/shared.js";
import { runPreflight } from "../src/runner.js";
import type { ConfiguredCheckKind, PreflightConfig } from "../src/types.js";

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return { ...actual, execa: vi.fn(actual.execa) };
});

const runners = { lint: runLintChecks, typecheck: runTypecheckChecks, test: runTestChecks, audit: runAuditChecks };
const kinds = Object.keys(runners) as ConfiguredCheckKind[];
let repoPath: string;
let logDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-commands-"));
  logDir = path.join(repoPath, "logs");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function onlyCheck(kind: ConfiguredCheckKind): PreflightConfig {
  return {
    logDir,
    checks: {
      gitState: false, lint: false, typecheck: false, test: false, audit: false,
      secretDetection: false, commitConvention: false, ciSimulation: false, tdd: false,
      [kind]: true,
    },
  };
}

function rawCommands(commands: unknown): PreflightConfig {
  return { commands, logDir } as PreflightConfig;
}

type FakeChild = Promise<Record<string, unknown>> & { kill: ReturnType<typeof vi.fn>; pid: number };

// A stand-in for the execa subprocess whose only way to end is the timeout
// kill: it settles when `kill()` is called, as a SIGTERM exit execa does not
// attribute to a timeout, and `kill()` reports the signal as delivered.
function childEndedByKill(extra: Record<string, unknown> = {}): FakeChild {
  let settle!: (value: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((resolve) => { settle = resolve; });
  const kill = vi.fn(() => {
    settle({ exitCode: undefined, signal: "SIGTERM", timedOut: false, isCanceled: false, all: "", stdout: "", stderr: "", ...extra });
    return true;
  });
  return Object.assign(promise, { kill, pid: 1 });
}

// A stand-in whose process ended on its own (so `kill()` finds nothing to
// signal and returns false) but whose result settles only after `ms`, the way
// a result does while a background descendant still holds the output pipe.
function childSettlingAfter(ms: number, fields: Record<string, unknown>): FakeChild {
  const promise = new Promise<Record<string, unknown>>((resolve) => {
    setTimeout(() => resolve({ timedOut: false, isCanceled: false, all: "", stdout: "", stderr: "", ...fields }), ms);
  });
  return Object.assign(promise, { kill: vi.fn(() => false), pid: 1 });
}

// A stand-in whose process the timeout kills while its output streams stay
// open, as when a descendant the kill does not reach still holds them. Like
// execa, it settles only once a stream is destroyed, with the output read so
// far and without an exit code or signal.
function childHoldingStreams(): FakeChild & { streams: PassThrough[] } {
  const streams = [new PassThrough(), new PassThrough(), new PassThrough()];
  const [stdout, stderr, all] = streams;
  const promise = new Promise<Record<string, unknown>>((resolve) => {
    for (const stream of streams) {
      stream.on("close", () => resolve({
        exitCode: undefined, signal: undefined, code: "ERR_STREAM_PREMATURE_CLOSE",
        timedOut: false, isCanceled: false, all: "partial", stdout: "partial", stderr: "",
      }));
    }
  });
  return Object.assign(promise, { kill: vi.fn(() => true), pid: 1, stdout, stderr, all, streams });
}

// A stand-in whose process exits on its own in the same turn of the event
// loop in which the timeout fires: its exit lands right after the timer
// callback. Until then `kill()` still reports the signal as delivered, as
// Node does for a child that has exited but whose exit it has not processed.
function childExitingWithTheTimer(timeoutMs: number, fields: Record<string, unknown>): FakeChild {
  let exited = false;
  const promise = new Promise<Record<string, unknown>>((resolve) => {
    // The microtask runs once the caller has armed its own timer, so this
    // timer, with the same delay, is due in the same turn and fires after it.
    queueMicrotask(() => setTimeout(() => {
      exited = true;
      resolve({ timedOut: false, isCanceled: false, all: "", stdout: "", stderr: "", ...fields });
    }, timeoutMs));
  });
  return Object.assign(promise, { kill: vi.fn(() => !exited), pid: 1 });
}

describe.each(kinds)("configured %s commands", (kind) => {
  it("runs mixed strings and objects with names and cwd relative to workingDir", async () => {
    const workingDir = path.join(repoPath, "service");
    const childDir = path.join(workingDir, "child folder");
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(workingDir, "workdir-marker"), "");
    fs.writeFileSync(path.join(childDir, "child-marker"), "");
    const result = await runPreflight(repoPath, {
      ...onlyCheck(kind),
      logDir,
      workingDir: "service",
      commands: {
        [kind]: [
          "test -f workdir-marker",
          { run: "pwd -P > actual.cwd; test -f child-marker", name: "child command", cwd: "child folder" },
          { run: "test -f workdir-marker" },
          "test -f workdir-marker",
        ],
      },
    });
    expect(result.checks.map(({ name, status }) => [name, status])).toEqual([
      [`${kind}:1`, "pass"], ["child command", "pass"], [`${kind}:3`, "pass"], [`${kind}:4`, "pass"],
    ]);
    expect(fs.readFileSync(path.join(childDir, "actual.cwd"), "utf8").trim()).toBe(fs.realpathSync(childDir));
  });

  it("honors an object timeout and continues with the next command", async () => {
    const result = await runners[kind](repoPath, {
      logDir,
      commands: { [kind]: [{ run: "exec sleep 1", timeoutMs: 20, name: "slow" }, "true"] },
    });
    expect(result.checks[0]).toMatchObject({ name: "slow", status: "fail" });
    expect(result.checks[1]).toMatchObject({ name: `${kind}:2`, status: "pass" });
  });

  it("retains the existing timeout default for both strings and objects", async () => {
    const execa = vi.mocked(execaModule.execa);
    const arm = vi.spyOn(globalThis, "setTimeout");
    await runners[kind](repoPath, { logDir, commands: { [kind]: ["true", { run: "true" }] } });
    expect(execa).toHaveBeenCalledTimes(2);
    const budget = kind === "test" ? 300_000 : 120_000;
    expect(arm.mock.calls.filter(([, delay]) => delay === budget)).toHaveLength(2);
  });

  it("keeps nonzero exits blocking even when output claims success", async () => {
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [{ run: "echo 'all checks passed'; exit 7", name: "failed command" }] },
    });
    expect(result.checks).toMatchObject([{ name: "failed command", status: "fail" }]);
  });

  it("uses a multiline output predicate for an explicit object, including required checks", async () => {
    const result = await runPreflight(repoPath, {
      ...onlyCheck(kind), logDir, requiredChecks: [kind],
      commands: { [kind]: [{ run: "printf 'notice\\nOK (12 tests, 30 assertions)\\n'; exit 1", passRegex: "^OK \\(" }] },
    });
    expect(result.checks).toMatchObject([{ status: "pass" }]);
    expect(result.ready).toBe(true);
  });

  it("lets failRegex veto a passRegex match and reports the predicate", async () => {
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [{ run: "printf 'OK (12 tests)\\nFAILURES!\\n'; exit 0", passRegex: "^OK \\(", failRegex: "^FAILURES!" }] },
    });
    expect(result.checks[0]).toMatchObject({ status: "fail" });
    expect(result.checks[0].message).toContain("failRegex");
  });

  it("fails when passRegex does not match even if exit is zero", async () => {
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [{ run: "echo incomplete; exit 0", passRegex: "^OK \\(" }] },
    });
    expect(result.checks[0]).toMatchObject({ status: "fail" });
    expect(result.checks[0].message).toContain("passRegex");
  });

  if (kind === "test") {
    const half = 65_536;
    const boundaryCases = [
      { name: "pass line complete inside the head", output: "P\n" + "x".repeat(half - 2) + "x".repeat(70_000) + "y".repeat(half), expected: "pass" },
      { name: "pass marker in the partial last head line", output: "\n" + "x".repeat(half - 2) + "P" + "x".repeat(70_000) + "y".repeat(half), expected: "fail" },
      { name: "pass line in the omitted middle", output: "x".repeat(half) + "\nP\n" + "x".repeat(70_000) + "y".repeat(half), expected: "fail" },
      { name: "pass marker in the partial first tail line", output: "x".repeat(half + 70_000) + "P" + "x".repeat(half - 2), expected: "fail" },
      { name: "pass line complete inside the tail", output: "x".repeat(200_000) + "\nP\n" + "x".repeat(10), expected: "pass" },
      { name: "pass line as the very last line of a long output", output: "x".repeat(200_000) + "\nP", expected: "pass" },
      { name: "veto line at the very end of a long output", output: "P\n" + "x".repeat(200_000) + "\nF", expected: "fail" },
      { name: "veto line inside the head of a long output", output: "F\n" + "x".repeat(200_000) + "\nP", expected: "fail" },
      { name: "veto marker in the partial first tail line", output: "P\n" + "x".repeat(100_000) + "F" + "x".repeat(half - 2), expected: "fail" },
      { name: "veto marker only in the omitted middle", output: "P\n" + "x".repeat(70_000) + "F" + "x".repeat(70_000) + "\n" + "y".repeat(half), expected: "pass" },
      { name: "pass line behind a short lead-in", output: "x".repeat(70_000) + "\nP", expected: "pass" },
      { name: "pass line at the start of a long output", output: "P\n" + "x".repeat(200_000), expected: "pass" },
    ] as const;

    it.each(boundaryCases)("searches the first and last 65536 UTF-16 code units: $name", async ({ output, expected }) => {
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 1, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "P", failRegex: "F" }] },
      });
      expect(result.checks[0].status).toBe(expected);
    });

    it("does not let a cut line turn 'NOT OK (' into a '^OK (' pass", async () => {
      const tail = "OK (3 tests, 1 failure)\n";
      const output = "x".repeat(70_000) + "\nNOT " + tail + "z".repeat(half - tail.length);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 1, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "^OK \\(" }] },
      });
      expect(result.checks[0].status).toBe("fail");
    });

    it.each([
      { name: "exactly 131072 code units is searched whole", pad: 0, expected: "pass" },
      { name: "131073 code units is split at the midpoint", pad: 1, expected: "fail" },
    ] as const)("pins the whole-output threshold: $name", async ({ pad, expected }) => {
      const output = "x".repeat(half - 2) + "ABCD" + "x".repeat(half - 2 + pad);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "ABCD" }] },
      });
      expect(result.checks[0].status).toBe(expected);
    });

    it("does not match a pattern across the omitted middle", async () => {
      const output = "x".repeat(half - 2) + "AB" + "x".repeat(70_000) + "CD" + "y".repeat(half - 2);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "ABCD" }] },
      });
      expect(result.checks[0].status).toBe("fail");
    });

    it("does not match passRegex across the omitted middle even over a line break", async () => {
      const head = "a".repeat(half - 11) + "\nSuite A\nxx";
      const tail = "yy\nfailed 0\n" + "z".repeat(half - 12);
      const output = head + "m".repeat(1000) + tail;
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "^Suite A\\s+failed 0$" }] },
      });
      expect(result.checks[0].status).toBe("fail");
    });

    it("does not let failRegex match across the omitted middle", async () => {
      const output = "P\n" + "x".repeat(half - 9) + "Suite A" + "m".repeat(1000) + "failed 0\n" + "z".repeat(half - 9);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "^P$", failRegex: "Suite A\\s*failed 0" }] },
      });
      expect(result.checks[0].status).toBe("pass");
    });

    it.each([
      { name: "a pattern ending at the line end matches", passRegex: "^OK \\(3\\)$", expected: "pass" },
      { name: "a pattern consuming the line terminator does not match", passRegex: "^OK \\(3\\)\n", expected: "fail" },
    ] as const)("ends the head part before the terminator of its last complete line: $name", async ({ passRegex, expected }) => {
      const output = "z".repeat(half - 10) + "\nOK (3)\nqq" + "q".repeat(70_000) + "y".repeat(half);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 1, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex }] },
      });
      expect(result.checks[0].status).toBe(expected);
    });

    it.each([
      { name: "an empty line after the verdict", next: "FAILURES!", passRegex: "^OK \\(3\\)\n^$", expected: "fail" },
      { name: "a lookahead past the terminator", next: "FAILURES!", passRegex: "^OK \\(3\\)\n(?!FAILURES)", expected: "fail" },
      { name: "a real empty line after the verdict", next: "\nFAILURES!", passRegex: "^OK \\(3\\)\n^$", expected: "pass" },
      { name: "a real complete line after the verdict", next: "PASSED\n", passRegex: "^OK \\(3\\)\n(?!FAILURES)", expected: "pass" },
    ] as const)("does not invent a line start at the head cut: $name", async ({ next, passRegex, expected }) => {
      const output = "x".repeat(1000) + "\nOK (3)\n" + next + "y".repeat(half) + "m".repeat(70_000) + "\n" + "z".repeat(half);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 1, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex }] },
      });
      expect(result.checks[0].status).toBe(expected);
    });

    it.each([
      { name: "no line terminator at all", output: "x".repeat(200_000) },
      { name: "a terminator only in the omitted middle", output: "x".repeat(half + 1000) + "\n" + "x".repeat(half + 1000) },
      { name: "the tail part after a cut partial line", output: "x".repeat(200_000) + "\nFAILURES! 1\nend" },
      { name: "the tail part after a cut partial line ending in CRLF", output: "x".repeat(200_000) + "\r\nOK\nend" },
    ])("does not let an empty-matching passRegex pass on a part left empty: $name", async ({ output }) => {
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "^$" }] },
      });
      expect(result.checks[0].status).toBe("fail");
    });

    it("drops a head without any line terminator for passRegex", async () => {
      const output = "x".repeat(half - 1) + "P" + "x".repeat(10_000) + "y".repeat(half);
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "P$" }] },
      });
      expect(result.checks[0].status).toBe("fail");
    });

    it.each([
      { name: "a CR-terminated cut line", output: "x".repeat(200_000) + "\rP" },
      { name: "a CRLF-terminated cut line", output: "x".repeat(200_000) + "\r\nP" },
      { name: "a U+2028-terminated cut line", output: "x".repeat(200_000) + "\u2028P" },
      { name: "a U+2029-terminated cut line", output: "x".repeat(200_000) + "\u2029P" },
    ])("treats $name as complete for the tail verdict", async ({ output }) => {
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 1, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "^P$" }] },
      });
      expect(result.checks[0].status).toBe("pass");
    });

    it("finds a real verdict line behind more than 128 KiB of output", async () => {
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "head -c 150000 /dev/zero | tr '\\0' x; printf '\\nOK (3 tests)\\n'; exit 1", passRegex: "^OK \\(" }] },
      });
      expect(result.checks[0].status).toBe("pass");
    });
  }

  it("never passes incomplete runs or exit 127 through the predicate", async () => {
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [
        { run: "echo OK; exec sleep 1", passRegex: "OK", timeoutMs: 20 },
        { run: "echo OK; exit 127", passRegex: "OK" },
        { run: "echo OK", passRegex: "OK", cwd: "missing" },
      ] },
    });
    expect(result.checks.map((check) => check.status)).toEqual(["fail", "fail", "fail"]);
  });

  it("does not predicate-pass a timed-out, signaled or exitless execa result", async () => {
    const execa = vi.mocked(execaModule.execa);
    // The timeout fires while the result still reads like a clean pass.
    execa.mockImplementationOnce((() => childEndedByKill({ exitCode: 0, signal: undefined, all: "OK" })) as never);
    execa.mockResolvedValueOnce({ exitCode: 0, all: "OK", timedOut: false, signal: "SIGTERM", isCanceled: false } as never);
    execa.mockResolvedValueOnce({ exitCode: undefined, all: "OK", timedOut: false, isCanceled: false } as never);
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [
        { run: "echo OK", passRegex: "OK", timeoutMs: 50 },
        { run: "echo OK", passRegex: "OK" },
        { run: "echo OK", passRegex: "OK" },
      ] },
    });
    expect(result.checks.map((check) => check.status)).toEqual(["fail", "fail", "fail"]);
  });

  it("reports timeouts without predicates and preserves other exit-code behavior", async () => {
    const execa = vi.mocked(execaModule.execa);
    execa.mockImplementationOnce((() => childEndedByKill({ exitCode: 0, signal: undefined, all: "OK" })) as never);
    execa.mockResolvedValueOnce({ exitCode: 0, all: "OK", timedOut: false, signal: "SIGTERM", isCanceled: false } as never);
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [{ run: "echo OK", timeoutMs: 50 }, { run: "echo OK" }] },
    });
    expect(result.checks.map((check) => [check.status, check.message])).toEqual([
      ["fail", `${kind} command failed: timed out after 50 ms`], ["pass", undefined],
    ]);
  });

  it("reports an unusable cwd as a failed command", async () => {
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [{ run: "true", cwd: "missing", name: "bad directory" }] },
    });
    expect(result.checks).toMatchObject([{ name: "bad directory", status: "fail" }]);
  });

  it.each([
    null, false, "true", {}, [null], [42], [""], ["   "], [{}], [{ run: 42 }], [{ run: " " }],
    [{ run: "true", name: "" }], [{ run: "true", name: 1 }],
    [{ run: "true", cwd: " " }], [{ run: "true", cwd: false }],
    [{ run: "true", timeoutMs: 0 }], [{ run: "true", timeoutMs: -1 }],
    [{ run: "true", timeoutMs: Infinity }], [{ run: "true", timeoutMs: NaN }],
    [{ run: "true", timeoutMs: 86_400_001 }], [{ run: "true", timeoutMs: "100" }],
    [{ run: "true", timeout: 100 }],
    [{ run: "true", passRegex: 1 }], [{ run: "true", failRegex: 1 }],
    [{ run: "true", failRegex: "FAILURES!" }],
    [{ run: "true", passRegex: "[" }], [{ run: "true", passRegex: "OK", failRegex: "[" }],
    ["touch should-not-run", { run: "true", cwd: null }],
  ].map((value) => ({ value })))("fails a malformed explicit override without executing a partial list: $value", async ({ value }) => {
    const result = await runners[kind](repoPath, rawCommands({ [kind]: value }));
    expect(result.checks).toMatchObject([{ name: `${kind}:configuration`, status: "fail" }]);
    expect(result.checks[0].message).toContain(`commands.${kind}`);
    expect(fs.existsSync(path.join(repoPath, "should-not-run"))).toBe(false);
  });
});

describe("configuration loading and precedence", () => {
  it.each(kinds)("retains malformed loaded %s overrides and blocks readiness", async (kind) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(repoPath, ".preflight.json"), JSON.stringify({
      ...onlyCheck(kind), commands: { [kind]: ["true", { run: "true", timeotMs: 100 }] },
    }));
    const result = await runPreflight(repoPath, { ...loadConfig(repoPath), logDir });
    expect(result.ready).toBe(false);
    expect(result.checks).toMatchObject([{ name: `${kind}:configuration`, status: "fail" }]);
    expect(result.blockers.join(" ")).toContain("timeotMs");
  });

  it.each([null, false, "true", [], { tset: ["true"] }].map((commands) => ({ commands })))("retains malformed commands containers through merging: $commands", async ({ commands }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(repoPath, ".preflight.json"), JSON.stringify({ ...onlyCheck("lint"), commands }));
    const config = loadConfig(repoPath);
    expect(config.commands).toEqual(commands);
    const result = await runPreflight(repoPath, { ...config, logDir });
    expect(warn).toHaveBeenCalled();
    expect(result.ready).toBe(false);
    expect(result.checks).toMatchObject([{ name: "lint:configuration", status: "fail" }]);
  });

  it("does not auto-detect a successful script when the explicit override is invalid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { lint: "touch detected" } }));
    fs.writeFileSync(path.join(repoPath, ".preflight.json"), JSON.stringify({ ...onlyCheck("lint"), commands: { lint: [null] } }));
    const result = await runPreflight(repoPath, { ...loadConfig(repoPath), logDir });
    expect(result.ready).toBe(false);
    expect(result.checks).toMatchObject([{ name: "lint:configuration", status: "fail" }]);
    expect(fs.existsSync(path.join(repoPath, "detected"))).toBe(false);
  });

  it("replaces each overridden category without losing other categories", async () => {
    const loaded = validateConfig({ commands: { lint: ["false"], test: [{ run: "true", name: "retained" }] } }).config;
    const config = mergeConfig({ ...loaded, logDir }, { commands: { lint: [{ run: "true", name: "override" }] } });
    const lint = await runLintChecks(repoPath, config);
    const test = await runTestChecks(repoPath, config);
    expect(lint.checks).toMatchObject([{ name: "override", status: "pass" }]);
    expect(test.checks).toMatchObject([{ name: "retained", status: "pass" }]);
    const invalid = mergeConfig(config, rawCommands({ lint: null }));
    expect((await runLintChecks(repoPath, invalid)).checks).toMatchObject([{ status: "fail" }]);
  });

  it("allows a valid override to replace a malformed commands container", async () => {
    const config = mergeConfig(rawCommands(null), { commands: { lint: [{ run: "true", name: "fixed" }] } });
    expect((await runLintChecks(repoPath, config)).checks).toMatchObject([{ name: "fixed", status: "pass" }]);
  });

  it("preserves auto-detection for an explicit empty array", async () => {
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { lint: "echo detected" } }));
    const result = await runLintChecks(repoPath, { logDir, commands: { lint: [] } });
    expect(result.checks).toMatchObject([{ name: "npm-lint", status: "pass" }]);
  });

  it("treats undefined optional properties as omitted in programmatic config", async () => {
    const commands = { lint: [{ run: "true", name: undefined, cwd: undefined, timeoutMs: undefined }], test: undefined };
    expect(validateConfig({ commands })).toEqual({ config: { commands }, warnings: [] });
    expect((await runLintChecks(repoPath, { commands, logDir })).checks).toMatchObject([{ name: "lint:1", status: "pass" }]);
    expect((await runTestChecks(repoPath, { commands, logDir })).checks).toEqual([]);
  });

  it("accepts command objects and positive finite timeout values without warnings", () => {
    const commands = { lint: ["true", { run: "true", name: "named", cwd: ".", timeoutMs: 0.5 }], test: [{ run: "true", timeoutMs: 86_400_000 }] };
    expect(validateConfig({ commands })).toEqual({ config: { commands }, warnings: [] });
  });
});

describe("configured test recursion protection", () => {
  it("recognizes a symlink cwd pointing to the current test repository", async () => {
    vi.stubEnv("VITEST", "true");
    const alias = path.join(repoPath, "current-repo");
    fs.symlinkSync(process.cwd(), alias, "dir");
    // Assert the guard first so a regression cannot recursively launch the suite.
    expect(shouldSkipRecursiveNodeTest(alias, "npm run test")).toBe(true);
    const result = await runTestChecks(repoPath, {
      logDir, commands: { test: [{ run: "npm run test", cwd: alias, name: "alias test" }] },
    });
    expect(result.checks).toMatchObject([{ name: "alias test", status: "skip" }]);
  });

  it("leaves a missing cwd to fail during execution", async () => {
    vi.stubEnv("VITEST", "true");
    const missing = path.join(repoPath, "missing");
    expect(shouldSkipRecursiveNodeTest(missing, "npm run test")).toBe(false);
    const result = await runTestChecks(repoPath, { logDir, commands: { test: [{ run: "npm run test", cwd: missing }] } });
    expect(result.checks).toMatchObject([{ name: "test:1", status: "fail" }]);
  });

  it("preserves names and occurrence numbers for partial recursive skips", async () => {
    vi.stubEnv("VITEST", "true");
    const result = await runTestChecks(repoPath, {
      logDir,
      commands: { test: [
        "true",
        { run: "npm run test", cwd: process.cwd(), name: "recursive named" },
        "true",
        { run: "vitest run", cwd: process.cwd() },
      ] },
    });
    expect(result.checks.map(({ name, status }) => [name, status])).toEqual([
      ["test:1", "pass"], ["recursive named", "skip"], ["test:3", "pass"], ["test:4", "skip"],
    ]);
    expect(result.limitations).toEqual(["Skipping recursive Node test command while already running under Vitest"]);
  });

  it("runs a Node test command in another cwd even when called from the current test repository", async () => {
    vi.stubEnv("VITEST", "true");
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "touch executed" } }));
    const result = await runTestChecks(process.cwd(), { logDir, commands: { test: [{ run: "npm run test", cwd: repoPath }] } });
    expect(result.checks).toMatchObject([{ name: "test:1", status: "pass" }]);
    expect(fs.existsSync(path.join(repoPath, "executed"))).toBe(true);
  });

  it("keeps string recursion skips visible", async () => {
    vi.stubEnv("VITEST", "true");
    const result = await runTestChecks(process.cwd(), { logDir, commands: { test: ["npm run test", "true"] } });
    expect(result.checks).toMatchObject([{ name: "test:1", status: "skip" }, { name: "test:2", status: "pass" }]);
  });
});


// Everything execa reported for the first call of this test, for the failure
// message of an assertion: a timing failure on a shared runner is otherwise
// only visible as a bare message mismatch.
async function execaOutcome(): Promise<string> {
  const first = vi.mocked(execaModule.execa).mock.results[0];
  if (!first) return "execa was never called";
  let settled: Record<string, unknown>;
  try {
    settled = (await first.value) as Record<string, unknown>;
  } catch (error) {
    settled = error as Record<string, unknown>;
  }
  const fields = ["exitCode", "signal", "failed", "timedOut", "isCanceled", "killed", "code", "shortMessage", "stderr"];
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, settled?.[field]])));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

// True once `pid` has exited and is waiting to be reaped. `ps` runs
// synchronously, so asking does not let this process's event loop run and
// process the exit.
function isZombie(pid: number): boolean {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

function shellCheck(command: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof shared.runShellCheck>>> {
  return shared.runShellCheck({
    name: "test", kind: "test", command, repoPath, logDir, timeoutMs, weight: 1, failureMessage: "test command failed",
  });
}

// The three places that run a command under a time budget: the configured
// command checks, the --setup build step and the npm audit runner. Each one
// returns whether the call was reported as timed out.
const timeoutSites: Array<[string, (timeoutMs: number) => Promise<boolean>]> = [
  ["a configured command", async (timeoutMs) => {
    const result = await runTestChecks(repoPath, { logDir, commands: { test: [{ run: "sleep 5", timeoutMs }] } });
    return String(result.checks[0].message).includes(`timed out after ${timeoutMs} ms`);
  }],
  ["the --setup build step", async (timeoutMs) => {
    fs.mkdirSync(path.join(repoPath, "node_modules"));
    fs.mkdirSync(path.join(repoPath, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node test.js" } }));
    fs.writeFileSync(path.join(repoPath, ".github", "workflows", "ci.yml"), "jobs:\n  t:\n    steps:\n      - run: npm run build\n      - run: npm test\n");
    const setup = await shared.ensureProjectSetup(repoPath, logDir, { buildTimeoutMs: timeoutMs });
    return setup.buildOutcome?.timedOut === true;
  }],
  ["the npm audit runner", async (timeoutMs) => {
    const original = npmAuditRunner.timeoutMs;
    npmAuditRunner.timeoutMs = timeoutMs;
    try {
      return (await npmAuditRunner.run(repoPath)).timedOut;
    } finally {
      npmAuditRunner.timeoutMs = original;
    }
  }],
];

describe("test command timeouts", () => {
  it("reports the configured timeout for a sleeping command and leaves no child behind", async () => {
    // The command outlives the budget by orders of magnitude, so only the
    // timeout can end it: a loaded runner that delays the timer or the spawn
    // cannot let it exit on its own first.
    const result = await runTestChecks(repoPath, {
      logDir, commands: { test: [{ run: "exec sleep 60", timeoutMs: 750 }] },
    });
    const outcome = await execaOutcome();
    const pid = (vi.mocked(execaModule.execa).mock.results[0]?.value as { pid?: number } | undefined)?.pid;
    try {
      const detail = `execa outcome: ${outcome}; check: ${JSON.stringify(result.checks[0])}`;
      expect(result.checks[0], detail).toMatchObject({ status: "fail" });
      expect(result.checks[0].message, detail).toContain("timed out after 750 ms");
      expect(result.checks[0].message, detail).not.toContain("build artifact");
      expect(pid, detail).toBeGreaterThan(0);
      // The kill is the contract: the child must be gone shortly after the
      // result, not left running for the rest of its 60 s sleep.
      expect(await waitUntil(() => !isAlive(pid as number), 5000), `child ${pid} still alive; ${detail}`).toBe(true);
    } finally {
      if (pid && isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  });

  it("does not call an early external SIGTERM a timeout when its result settles after the budget", async () => {
    // bash dies by SIGTERM at once, while a background child keeps the output
    // pipe open past the budget, so the result settles late with a SIGTERM
    // signal. The budget has run out by then, but the timeout did not kill it.
    const result = await runTestChecks(repoPath, {
      logDir, commands: { test: [{ run: "sleep 2 & kill -TERM $$", timeoutMs: 750 }] },
    });
    const detail = `execa outcome: ${await execaOutcome()}; check: ${JSON.stringify(result.checks[0])}`;
    expect(result.checks[0], detail).toMatchObject({ status: "fail", message: "test command failed" });
  });

  it("does not call a plain non-zero exit a timeout", async () => {
    const result = await runTestChecks(repoPath, {
      logDir, commands: { test: [{ run: "exit 3", timeoutMs: 60_000 }] },
    });
    expect(result.checks[0]).toMatchObject({ status: "fail", message: "test command failed" });
  });

  it("waits for a descendant of a command that exited on its own, without tearing down its output", async () => {
    // The command exits 0 before the budget; a background sleep keeps the
    // output open past budget + grace. No kill was delivered, so this is a
    // clean pass and the streams are not destroyed.
    const result = await shellCheck("(sleep 2 &); echo ok; exit 0", 300);
    const detail = `execa outcome: ${await execaOutcome()}; check: ${JSON.stringify(result.check)}`;
    expect(result.check, detail).toMatchObject({ status: "pass" });
    expect(result.rawOutput ?? "", detail).toContain("ok");
  }, 20_000);

  it("returns shortly after the timeout when a descendant keeps the output open", async () => {
    // The timeout kills bash; the background sleep it started is not killed
    // and keeps bash's stdout and stderr open for 30 s.
    const started = Date.now();
    const result = await shellCheck('sleep 30 & echo "descendant $!"; wait', 300);
    const elapsed = Date.now() - started;
    const descendant = Number(/descendant (\d+)/.exec(result.rawOutput ?? "")?.[1]);
    try {
      const detail = `elapsed ${elapsed} ms; execa outcome: ${await execaOutcome()}; check: ${JSON.stringify(result.check)}`;
      expect(result.check, detail).toMatchObject({ status: "fail", message: "test command failed: timed out after 300 ms" });
      expect(descendant, detail).toBeGreaterThan(0);
      // The descendant still held the output when the call returned.
      expect(isAlive(descendant), detail).toBe(true);
      expect(elapsed, detail).toBeLessThan(3000);
    } finally {
      if (descendant > 0 && isAlive(descendant)) {
        try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ }
      }
    }
  }, 40_000);

  it("reports a timeout for a command that exits 0 on the timeout's SIGTERM", async () => {
    // The trap turns the SIGTERM into exit 0, so the exit status alone reads
    // like a clean pass. The timeout ended the command all the same.
    const result = await runTestChecks(repoPath, {
      logDir, commands: { test: [{ run: "trap 'echo got-term; exit 0' TERM; echo ready; while :; do sleep 0.05; done", timeoutMs: 750 }] },
    });
    const detail = `execa outcome: ${await execaOutcome()}; check: ${JSON.stringify(result.checks[0])}`;
    expect(result.checks[0], detail).toMatchObject({ status: "fail", message: "test command failed: timed out after 750 ms" });
    // The timeout sends SIGTERM first (the trap runs); SIGKILL only follows later.
    const settled = (await vi.mocked(execaModule.execa).mock.results[0]?.value) as { all?: string; stdout?: string };
    expect(String(settled?.all ?? settled?.stdout ?? ""), detail).toContain("got-term");
  });

  it.each([
    [0, "pass", undefined],
    [3, "fail", "test command failed"],
  ])("does not call exit %i a timeout when the timer fires before Node has processed that exit", async (code, status, message) => {
    // The command is started from the check phase of the event loop, and the
    // loop is then held until the command has exited and the budget is spent.
    // The next timers phase comes before the next poll phase, in which Node
    // processes child exits, so the timer fires while the exited child is
    // still unreaped and kill(2) on it would still succeed.
    await new Promise((resolve) => setImmediate(resolve));
    const budget = 50;
    const started = Date.now();
    const pending = shellCheck(`exit ${code}`, budget);
    const pid = (vi.mocked(execaModule.execa).mock.results[0]?.value as { pid?: number } | undefined)?.pid as number;
    while (!(isZombie(pid) && Date.now() - started > budget + 50) && Date.now() - started < 20_000) {
      // hold the event loop
    }
    const unreaped = isZombie(pid);
    const result = await pending;
    const detail = `unreaped ${unreaped}; execa outcome: ${await execaOutcome()}; check: ${JSON.stringify(result.check)}`;
    expect(unreaped, detail).toBe(true);
    expect(result.check, detail).toMatchObject({ status, message });
  });

  describe.each(timeoutSites)("%s", (_site, run) => {
    it("reports a timeout when the timer fires and kills the child", async () => {
      const child = childEndedByKill();
      vi.mocked(execaModule.execa).mockImplementationOnce((() => child) as never);
      expect(await run(50)).toBe(true);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("does not pass a timeout option to execa", async () => {
      vi.mocked(execaModule.execa).mockImplementationOnce((() => childEndedByKill()) as never);
      await run(50);
      const call = vi.mocked(execaModule.execa).mock.calls[0] as unknown as unknown[];
      expect(call[2]).not.toHaveProperty("timeout");
    });

    it("does not call an early SIGTERM a timeout when its result settles after the budget", async () => {
      const child = childSettlingAfter(120, { exitCode: undefined, signal: "SIGTERM" });
      vi.mocked(execaModule.execa).mockImplementationOnce((() => child) as never);
      expect(await run(50)).toBe(false);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("does not call a late SIGKILL or a non-zero exit a timeout", async () => {
      for (const fields of [{ exitCode: undefined, signal: "SIGKILL" }, { exitCode: 1 }]) {
        vi.mocked(execaModule.execa).mockImplementationOnce((() => childSettlingAfter(120, fields)) as never);
        expect(await run(50), JSON.stringify(fields)).toBe(false);
        fs.rmSync(path.join(repoPath, "node_modules"), { recursive: true, force: true });
      }
    });

    it("does not call an exit a timeout when it lands in the same turn as the timer", async () => {
      const child = childExitingWithTheTimer(50, { exitCode: 0 });
      vi.mocked(execaModule.execa).mockImplementationOnce((() => child) as never);
      expect(await run(50)).toBe(false);
    });

    it("destroys the output streams after the grace when the killed child's streams stay open", async () => {
      const child = childHoldingStreams();
      vi.mocked(execaModule.execa).mockImplementationOnce((() => child) as never);
      const outcome = await Promise.race([
        run(50).then((timedOut) => ({ timedOut })),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), shared.TIMEOUT_STREAM_GRACE_MS + 3000)),
      ]);
      expect(outcome).toEqual({ timedOut: true });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.streams.map((stream) => stream.destroyed)).toEqual([true, true, true]);
    });

    it("stops the timer once the child has settled", async () => {
      const child = childSettlingAfter(0, { exitCode: 1 });
      vi.mocked(execaModule.execa).mockImplementationOnce((() => child) as never);
      expect(await run(150)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("does not classify incomplete default test output as a missing build", async () => {
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({
      main: "dist/index.js", scripts: { build: "tsc", test: "node test.js" },
    }));
    // The default 300 s budget runs out on fake timers while the child's last
    // output looks like a missing build artifact.
    vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 0 } as never).mockImplementationOnce((() =>
      childEndedByKill({ all: "Error: Cannot find module './dist/index.js'" })) as never);
    const classifier = vi.spyOn(shared, "evaluateBuildRequiredTestFailure");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: Awaited<ReturnType<typeof runTestChecks>>;
    try {
      let done = false;
      const pending = runTestChecks(repoPath, { logDir }).then((value) => { done = true; return value; });
      for (let i = 0; i < 200 && !done; i++) {
        await vi.advanceTimersByTimeAsync(300_000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      result = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(result.checks[0]).toMatchObject({ status: "fail" });
    expect(result.checks[0].message).toContain("timed out after 300000 ms");
    expect(result.checks[0].message).not.toContain("build artifact");
    expect(classifier).not.toHaveBeenCalled();
    expect(result.limitations).toEqual([]);
  });
});
