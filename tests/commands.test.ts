import fs from "fs";
import os from "os";
import path from "path";
import * as execaModule from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, mergeConfig, validateConfig } from "../src/config.js";
import { runAuditChecks } from "../src/checks/audit.js";
import { runLintChecks } from "../src/checks/lint.js";
import { runTestChecks } from "../src/checks/test.js";
import { runTypecheckChecks } from "../src/checks/typecheck.js";
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
    await runners[kind](repoPath, { logDir, commands: { [kind]: ["true", { run: "true" }] } });
    expect(execa).toHaveBeenCalledTimes(2);
    for (const occurrence of [1, 2]) {
      expect(execa).toHaveBeenNthCalledWith(occurrence, "bash", ["-c", "true"], expect.objectContaining({
        timeout: kind === "test" ? 300_000 : 120_000,
      }));
    }
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
    execa.mockResolvedValueOnce({ exitCode: 0, all: "OK", timedOut: true, isCanceled: false } as never);
    execa.mockResolvedValueOnce({ exitCode: 0, all: "OK", timedOut: false, signal: "SIGTERM", isCanceled: false } as never);
    execa.mockResolvedValueOnce({ exitCode: undefined, all: "OK", timedOut: false, isCanceled: false } as never);
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: [
        { run: "echo OK", passRegex: "OK" },
        { run: "echo OK", passRegex: "OK" },
        { run: "echo OK", passRegex: "OK" },
      ] },
    });
    expect(result.checks.map((check) => check.status)).toEqual(["fail", "fail", "fail"]);
  });

  it("keeps the existing status and message for commands without predicates", async () => {
    const execa = vi.mocked(execaModule.execa);
    execa.mockResolvedValueOnce({ exitCode: 0, all: "OK", timedOut: true, isCanceled: false } as never);
    execa.mockResolvedValueOnce({ exitCode: 0, all: "OK", timedOut: false, signal: "SIGTERM", isCanceled: false } as never);
    const result = await runners[kind](repoPath, {
      logDir, commands: { [kind]: ["echo OK", { run: "echo OK" }] },
    });
    expect(result.checks.map((check) => [check.status, check.message])).toEqual([
      ["pass", undefined], ["pass", undefined],
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
