/**
 * Explicit config file for `preflight run` (--config / PREFLIGHT_CONFIG,
 * issue #100): loader precedence, path resolution, failure modes, the
 * reported config source, and the sandbox rejection. The CLI cases run the
 * real runner against throwaway fixture repos with only custom checks on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ExplicitConfigError,
  loadConfigFromFile,
  loadConfigWithSource,
  resolveExplicitConfig,
} from "../src/config.js";
import { createProgram } from "../src/cli.js";
import { createSandboxPlan } from "../src/sandbox.js";
import { runBatch } from "../src/batch.js";
import type { PreflightResult } from "../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const BASE_CHECKS = {
  gitState: false,
  lint: false,
  typecheck: false,
  test: false,
  audit: false,
  ciSimulation: false,
  commitConvention: false,
  secretDetection: false,
  tdd: false,
};

function configWithCheck(name: string, command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    checks: BASE_CHECKS,
    customChecks: [{ name, command }],
    logDir: path.join(makeTempDir("preflight-cfgpath-logs-"), "logs"),
    ...extra,
  });
}

function makeRepo(repoConfig?: string): string {
  const repo = makeTempDir("preflight-cfgpath-repo-");
  if (repoConfig !== undefined) fs.writeFileSync(path.join(repo, ".preflight.json"), repoConfig);
  return repo;
}

function writeFile(dir: string, name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

async function runCli(args: string[]): Promise<{
  exitCode: number | undefined;
  json: PreflightResult | undefined;
  stdout: string;
  stderr: string;
}> {
  let exitCode: number | undefined;
  let out = "";
  let err = "";
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    if (exitCode === undefined) exitCode = code;
    return undefined as never;
  }) as typeof process.exit);
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out += `${a.map(String).join(" ")}\n`;
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    encodingOrCallback?: unknown,
    maybeCallback?: unknown
  ) => {
    out += String(chunk);
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    if (typeof callback === "function") queueMicrotask(() => (callback as () => void)());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    await createProgram().parseAsync(args, { from: "user" });
    for (let i = 0; i < 5; i++) await Promise.resolve();
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  let json: PreflightResult | undefined;
  try {
    json = JSON.parse(out) as PreflightResult;
  } catch {
    json = undefined;
  }
  return { exitCode, json, stdout: out, stderr: err };
}

beforeEach(() => {
  vi.stubEnv("PREFLIGHT_CONFIG", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveExplicitConfig", () => {
  it("prefers the option over the environment variable", () => {
    expect(resolveExplicitConfig("a.json", { PREFLIGHT_CONFIG: "b.json" })).toEqual({
      path: "a.json",
      origin: "option",
    });
  });

  it("uses the environment variable when no option is given", () => {
    expect(resolveExplicitConfig(undefined, { PREFLIGHT_CONFIG: "b.json" })).toEqual({
      path: "b.json",
      origin: "env",
    });
  });

  it("treats an empty or blank environment variable as unset", () => {
    expect(resolveExplicitConfig(undefined, { PREFLIGHT_CONFIG: "" })).toBeUndefined();
    expect(resolveExplicitConfig(undefined, { PREFLIGHT_CONFIG: "  " })).toBeUndefined();
    expect(resolveExplicitConfig(undefined, {})).toBeUndefined();
  });

  it("rejects an empty option value instead of falling back", () => {
    expect(() => resolveExplicitConfig("", { PREFLIGHT_CONFIG: "b.json" })).toThrow(ExplicitConfigError);
  });
});

describe("loadConfigFromFile", () => {
  it("throws for a missing file, a directory, broken JSON and a non-object top level", () => {
    const dir = makeTempDir("preflight-cfgpath-files-");
    expect(() => loadConfigFromFile(path.join(dir, "missing.json"))).toThrow(/not found/);
    expect(() => loadConfigFromFile(dir)).toThrow(/not a file/);
    expect(() => loadConfigFromFile(writeFile(dir, "bad.json", "{ nope"))).toThrow(/not valid JSON/);
    expect(() => loadConfigFromFile(writeFile(dir, "arr.json", "[]"))).toThrow(/expected an object/);
    expect(() => loadConfigFromFile(writeFile(dir, "null.json", "null"))).toThrow(ExplicitConfigError);
  });

  it("throws for an unreadable file", () => {
    if (process.getuid?.() === 0) return;
    const dir = makeTempDir("preflight-cfgpath-files-");
    const file = writeFile(dir, "locked.json", "{}");
    fs.chmodSync(file, 0o000);
    expect(() => loadConfigFromFile(file)).toThrow(/cannot read/);
  });

  it("merges a clean file over the defaults", () => {
    const dir = makeTempDir("preflight-cfgpath-files-");
    const file = writeFile(dir, "ok.json", JSON.stringify({ protectedBranches: ["trunk"] }));
    const loaded = loadConfigFromFile(file);
    expect(loaded.config.protectedBranches).toEqual(["trunk"]);
    expect(loaded.config.checks?.lint).toBe(true);
    expect(loaded.path).toBe(file);
  });

  it("treats every validation warning as fatal and lists all of them", () => {
    const dir = makeTempDir("preflight-cfgpath-files-");
    const file = writeFile(
      dir,
      "warn.json",
      JSON.stringify({
        logDir: 5,
        checks: { secretDetection: "yes" },
        customChecks: [{ name: "must-run", comand: "false" }],
        customCheck: [],
      })
    );
    let message = "";
    try {
      loadConfigFromFile(file);
    } catch (err) {
      expect(err).toBeInstanceOf(ExplicitConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toContain("logDir");
    expect(message).toContain("checks.secretDetection");
    expect(message).toContain("customChecks[0]");
    expect(message).toContain('unrecognized field "customCheck"');
  });
});

describe("loadConfigWithSource", () => {
  it("reports repo, none, option and env sources with their paths", () => {
    const external = writeFile(makeTempDir("preflight-cfgpath-ext-"), "ext.json", "{}");
    const repoWith = makeRepo("{}");
    const repoWithout = makeRepo();

    expect(loadConfigWithSource(repoWith).source).toEqual({
      source: "repo",
      path: path.join(repoWith, ".preflight.json"),
    });
    expect(loadConfigWithSource(repoWithout).source).toEqual({ source: "none", path: null });
    expect(loadConfigWithSource(repoWith, external).source).toEqual({ source: "option", path: external });
    vi.stubEnv("PREFLIGHT_CONFIG", external);
    expect(loadConfigWithSource(repoWith).source).toEqual({ source: "env", path: external });
  });

  it("applies precedence option > env > repo without merging the repo file", () => {
    const dir = makeTempDir("preflight-cfgpath-ext-");
    const optionFile = writeFile(dir, "option.json", JSON.stringify({ protectedBranches: ["from-option"] }));
    const envFile = writeFile(dir, "env.json", JSON.stringify({ protectedBranches: ["from-env"] }));
    const repo = makeRepo(JSON.stringify({ protectedBranches: ["from-repo"], workingDir: "pkg" }));

    vi.stubEnv("PREFLIGHT_CONFIG", envFile);
    expect(loadConfigWithSource(repo, optionFile).config.protectedBranches).toEqual(["from-option"]);
    const viaEnv = loadConfigWithSource(repo).config;
    expect(viaEnv.protectedBranches).toEqual(["from-env"]);
    expect(viaEnv.workingDir).toBe(".");
    vi.stubEnv("PREFLIGHT_CONFIG", "");
    expect(loadConfigWithSource(repo).config.protectedBranches).toEqual(["from-repo"]);
  });

  it("resolves a relative explicit path against the current directory, not the repo", () => {
    const cwdDir = makeTempDir("preflight-cfgpath-cwd-");
    const repo = makeRepo();
    writeFile(cwdDir, "rel.json", JSON.stringify({ protectedBranches: ["from-cwd"] }));
    writeFile(repo, "rel.json", JSON.stringify({ protectedBranches: ["from-repo-dir"] }));
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

    const loaded = loadConfigWithSource(repo, "rel.json");
    expect(loaded.config.protectedBranches).toEqual(["from-cwd"]);
    expect(loaded.source.path).toBe(path.join(cwdDir, "rel.json"));
  });

  it("does not fall back to the repo file when the explicit file is missing", () => {
    const repo = makeRepo("{}");
    const missing = path.join(makeTempDir("preflight-cfgpath-ext-"), "missing.json");
    expect(() => loadConfigWithSource(repo, missing)).toThrow(ExplicitConfigError);
    vi.stubEnv("PREFLIGHT_CONFIG", missing);
    expect(() => loadConfigWithSource(repo)).toThrow(ExplicitConfigError);
  });

  it("keeps the previous behaviour for a broken repo file (warning, defaults)", () => {
    const repo = makeRepo("{ broken");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loaded = loadConfigWithSource(repo);
    expect(loaded.config.checks?.lint).toBe(true);
    expect(loaded.config.workingDir).toBe(".");
    expect(loaded.source).toEqual({ source: "none", path: null });
  });

  it("reports none when the repo .preflight.json is a directory or not an object", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dirRepo = makeRepo();
    fs.mkdirSync(path.join(dirRepo, ".preflight.json"));
    expect(loadConfigWithSource(dirRepo).source).toEqual({ source: "none", path: null });
    expect(loadConfigWithSource(makeRepo("[]")).source).toEqual({ source: "none", path: null });
  });

  it("keeps reporting repo for a repo file that loads with field warnings", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = makeRepo(JSON.stringify({ logDir: 5, protectedBranches: ["x"] }));
    const loaded = loadConfigWithSource(repo);
    expect(loaded.source.source).toBe("repo");
    expect(loaded.config.protectedBranches).toEqual(["x"]);
  });
});

describe("preflight run --config (real runner)", () => {
  it("runs the external config's checks and ignores the repo file", async () => {
    const repo = makeRepo(configWithCheck("repo-check", "true"));
    const external = writeFile(makeTempDir("preflight-cfgpath-ext-"), "shared.json", configWithCheck("external-check", "true"));

    const { exitCode, json } = await runCli(["run", repo, "--json", "--config", external]);
    expect(exitCode).toBe(0);
    expect(json?.checks.map((c) => c.name)).toEqual(["external-check"]);
    expect(json?.config).toEqual({ source: "option", path: external });
  });

  it("uses PREFLIGHT_CONFIG without the option, and the option beats the variable", async () => {
    const repo = makeRepo(configWithCheck("repo-check", "true"));
    const dir = makeTempDir("preflight-cfgpath-ext-");
    const envFile = writeFile(dir, "env.json", configWithCheck("env-check", "true"));
    const optionFile = writeFile(dir, "option.json", configWithCheck("option-check", "true"));
    vi.stubEnv("PREFLIGHT_CONFIG", envFile);

    const viaEnv = await runCli(["run", repo, "--json"]);
    expect(viaEnv.json?.checks.map((c) => c.name)).toEqual(["env-check"]);
    expect(viaEnv.json?.config).toEqual({ source: "env", path: envFile });

    const viaOption = await runCli(["run", repo, "--json", "--config", optionFile]);
    expect(viaOption.json?.checks.map((c) => c.name)).toEqual(["option-check"]);
    expect(viaOption.json?.config).toEqual({ source: "option", path: optionFile });
  });

  it("without option and variable behaves as before and reports repo or none", async () => {
    const repo = makeRepo(configWithCheck("repo-check", "true"));
    const withRepo = await runCli(["run", repo, "--json"]);
    expect(withRepo.json?.checks.map((c) => c.name)).toEqual(["repo-check"]);
    expect(withRepo.json?.config).toEqual({ source: "repo", path: path.join(repo, ".preflight.json") });
    // Existing result fields are still present.
    expect(Object.keys(withRepo.json ?? {})).toEqual(
      expect.arrayContaining(["ready", "confidence", "checks", "blockers", "warnings", "limitations", "durationMs", "timestamp"])
    );

    const bare = makeRepo();
    const withNone = await runCli(["run", bare, "--json", "--no-audit", "--no-secrets"]);
    expect(withNone.json?.config).toEqual({ source: "none", path: null });
  });

  it("resolves a relative --config against the current directory", async () => {
    const cwdDir = makeTempDir("preflight-cfgpath-cwd-");
    writeFile(cwdDir, "rel.json", configWithCheck("cwd-check", "true"));
    const repo = makeRepo(configWithCheck("repo-check", "true"));
    writeFile(repo, "rel.json", configWithCheck("repo-dir-check", "true"));
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

    const { json } = await runCli(["run", repo, "--json", "--config", "rel.json"]);
    expect(json?.checks.map((c) => c.name)).toEqual(["cwd-check"]);
    expect(json?.config?.path).toBe(path.join(cwdDir, "rel.json"));
  });

  it("resolves workingDir from the external config relative to the target repo", async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, "pkg"));
    fs.writeFileSync(path.join(repo, "pkg", "marker.txt"), "x");
    const external = writeFile(
      makeTempDir("preflight-cfgpath-ext-"),
      "shared.json",
      configWithCheck("in-subdir", "test -f marker.txt", { workingDir: "pkg" })
    );

    const { exitCode, json } = await runCli(["run", repo, "--json", "--config", external]);
    expect(exitCode).toBe(0);
    expect(json?.checks.find((c) => c.name === "in-subdir")?.status).toBe("pass");
  });

  it("prints the config source in the human-readable summary", async () => {
    const repo = makeRepo();
    const external = writeFile(makeTempDir("preflight-cfgpath-ext-"), "shared.json", configWithCheck("external-check", "true"));
    const { stdout } = await runCli(["run", repo, "--config", external]);
    expect(stdout).toContain(`Config: ${external} (option)`);
  });

  it.each([
    ["a missing file", (dir: string) => path.join(dir, "missing.json")],
    ["a directory", (dir: string) => dir],
    ["broken JSON", (dir: string) => writeFile(dir, "bad.json", "{ nope")],
    ["a non-object top level", (dir: string) => writeFile(dir, "arr.json", "[1]")],
  ])("fails with exit 1 and runs no check for %s", async (_label, make) => {
    const sentinelDir = makeTempDir("preflight-cfgpath-sentinel-");
    const sentinel = path.join(sentinelDir, "ran");
    const repo = makeRepo(configWithCheck("repo-check", `touch ${sentinel}`));
    const target = make(makeTempDir("preflight-cfgpath-ext-"));

    const viaOption = await runCli(["run", repo, "--json", "--config", target]);
    expect(viaOption.exitCode).toBe(1);
    expect(viaOption.json).toBeUndefined();
    expect(viaOption.stderr).toContain("preflight:");
    expect(viaOption.stderr).toContain(target);

    vi.stubEnv("PREFLIGHT_CONFIG", target);
    const viaEnv = await runCli(["run", repo, "--json"]);
    expect(viaEnv.exitCode).toBe(1);
    expect(viaEnv.json).toBeUndefined();

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("fails with exit 1, lists every problem and runs no check for an explicit file with field warnings", async () => {
    const sentinel = path.join(makeTempDir("preflight-cfgpath-sentinel-"), "ran");
    const repo = makeRepo(configWithCheck("repo-check", `touch ${sentinel}`));
    const bad = writeFile(
      makeTempDir("preflight-cfgpath-ext-"),
      "drop.json",
      JSON.stringify({
        checks: { ...BASE_CHECKS, secretDetection: "yes" },
        customChecks: [{ name: "must-run", comand: `touch ${sentinel}` }],
        customCheck: [],
      })
    );

    const viaOption = await runCli(["run", repo, "--json", "--config", bad]);
    expect(viaOption.exitCode).toBe(1);
    expect(viaOption.json).toBeUndefined();
    expect(viaOption.stderr).toContain("customChecks[0]");
    expect(viaOption.stderr).toContain("checks.secretDetection");
    expect(viaOption.stderr).toContain('unrecognized field "customCheck"');

    vi.stubEnv("PREFLIGHT_CONFIG", bad);
    const viaEnv = await runCli(["run", repo, "--json"]);
    expect(viaEnv.exitCode).toBe(1);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("still runs with warnings from a repo file (lenient behaviour unchanged)", async () => {
    const repo = makeRepo(configWithCheck("repo-check", "true", { surprise: true }));
    const { exitCode, json } = await runCli(["run", repo, "--json"]);
    expect(exitCode).toBe(0);
    expect(json?.config?.source).toBe("repo");
  });

  it("does not pass PREFLIGHT_CONFIG on to check commands", async () => {
    const repo = makeRepo();
    const external = writeFile(
      makeTempDir("preflight-cfgpath-ext-"),
      "shared.json",
      configWithCheck("env-hidden", 'test -z "${PREFLIGHT_CONFIG+set}"')
    );
    const { exitCode, json } = await runCli(["run", repo, "--json", "--config", external]);
    expect(exitCode).toBe(0);
    expect(json?.checks.find((c) => c.name === "env-hidden")?.status).toBe("pass");
    vi.stubEnv("PREFLIGHT_CONFIG", external);
    const viaEnv = await runCli(["run", repo, "--json"]);
    expect(viaEnv.json?.checks.find((c) => c.name === "env-hidden")?.status).toBe("pass");
  });

  it("treats an empty PREFLIGHT_CONFIG as unset", async () => {
    const repo = makeRepo(configWithCheck("repo-check", "true"));
    vi.stubEnv("PREFLIGHT_CONFIG", "");
    const { json } = await runCli(["run", repo, "--json"]);
    expect(json?.config?.source).toBe("repo");
  });
});

describe("batch ignores an explicit config", () => {
  it("uses each repo's own file even when PREFLIGHT_CONFIG is set", async () => {
    const root = makeTempDir("preflight-cfgpath-batch-");
    const repo = path.join(root, "one");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".preflight.json"), configWithCheck("repo-check", "true"));
    const sentinel = path.join(makeTempDir("preflight-cfgpath-sentinel-"), "ran");
    const external = writeFile(
      makeTempDir("preflight-cfgpath-ext-"),
      "shared.json",
      configWithCheck("external-check", `touch ${sentinel}`)
    );
    vi.stubEnv("PREFLIGHT_CONFIG", external);

    const batch = await runBatch(root);
    expect(batch.results[0].result?.checks.map((c) => c.name)).toEqual(["repo-check"]);
    expect(batch.results[0].result?.config).toBeUndefined();
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});

describe("sandbox rejects an explicit config", () => {
  it("exits 1 with a one-line message and no stack trace at the CLI", async () => {
    vi.stubEnv("PREFLIGHT_CONFIG", "/some/shared.json");
    const { exitCode, stderr } = await runCli(["sandbox", makeRepo(), "--print"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("preflight: sandbox does not support an explicit config file");
    expect(stderr).not.toContain("    at ");
  });

  it("fails with a clear message for the environment variable", async () => {
    vi.stubEnv("PREFLIGHT_CONFIG", "/some/shared.json");
    await expect(createSandboxPlan(makeRepo(), { print: true })).rejects.toThrow(
      /sandbox does not support an explicit config file \(PREFLIGHT_CONFIG is set\)/
    );
  });

  it("fails with a clear message for the --config option", async () => {
    await expect(createSandboxPlan(makeRepo(), { print: true, config: "/some/shared.json" })).rejects.toThrow(
      /sandbox does not support an explicit config file \(--config is set\)/
    );
  });

  it("is unaffected when neither is set", async () => {
    const plan = await createSandboxPlan(makeRepo(), { print: true });
    expect(plan.runCommand.length).toBeGreaterThan(0);
  });
});
