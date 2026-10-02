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
      { name: "pass marker at the last head code unit", output: "x".repeat(half - 1) + "P" + "x".repeat(70_000) + "y".repeat(half), expected: "pass" },
      { name: "pass marker at the first omitted code unit", output: "x".repeat(half) + "P" + "x".repeat(70_000) + "y".repeat(half), expected: "fail" },
      { name: "pass marker at the last omitted code unit", output: "x".repeat(half) + "x".repeat(70_000) + "P" + "y".repeat(half), expected: "fail" },
      { name: "pass marker at the first tail code unit", output: "x".repeat(half) + "x".repeat(70_000) + "P" + "y".repeat(half - 1), expected: "pass" },
      { name: "pass marker at the very end of a long output", output: "x".repeat(200_000) + "P", expected: "pass" },
      { name: "veto marker at the very end of a long output", output: "P" + "x".repeat(200_000) + "F", expected: "fail" },
      { name: "veto marker only in the omitted middle", output: "P" + "x".repeat(70_000) + "F" + "x".repeat(70_000) + "y".repeat(half), expected: "pass" },
      { name: "pass marker after a short lead-in", output: "x".repeat(70_000) + "P", expected: "pass" },
      { name: "pass marker at the start of a long output", output: "P" + "x".repeat(200_000), expected: "pass" },
      { name: "pass after a surrogate pair at the last head code unit", output: "😀" + "x".repeat(half - 3) + "P" + "x".repeat(70_000) + "y".repeat(half), expected: "pass" },
    ] as const;

    it.each(boundaryCases)("searches the first and last 65536 UTF-16 code units: $name", async ({ output, expected }) => {
      vi.mocked(execaModule.execa).mockResolvedValueOnce({ exitCode: 1, all: output, timedOut: false, isCanceled: false } as never);
      const result = await runTestChecks(repoPath, {
        logDir, commands: { test: [{ run: "mocked predicate output", passRegex: "P", failRegex: "F" }] },
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
