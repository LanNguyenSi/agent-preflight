import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runLintChecks } from "../src/checks/lint.js";
import { runTypecheckChecks } from "../src/checks/typecheck.js";
import { runTestChecks } from "../src/checks/test.js";
import { runPreflight } from "../src/runner.js";
import { classifyGitdir, dependenciesNotInstalledResult, isDependenciesNotInstalled } from "../src/checks/shared.js";

const HINT = "dependencies not installed; run with --setup or install first";
const tempDirs: string[] = [];
const originalPath = process.env.PATH;

// A throwaway Node project whose `npm`/`npx` are shims that record each call
// and exit 1, so a check that really runs shows up as a `fail` and a check
// that was held back shows up as no recorded call.
function makeRepo(opts: { installed: boolean; dependencies?: Record<string, string> }): { repoPath: string; callsPath: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-missing-deps-"));
  tempDirs.push(repoPath);
  const binDir = path.join(repoPath, ".bin");
  const callsPath = path.join(repoPath, "calls.txt");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" },
      devDependencies: opts.dependencies ?? { vitest: "^1.0.0" },
    })
  );
  fs.writeFileSync(path.join(repoPath, "tsconfig.json"), "{}");
  if (opts.installed) fs.mkdirSync(path.join(repoPath, "node_modules"));
  for (const command of ["npm", "npx"]) {
    fs.writeFileSync(
      path.join(binDir, command),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${command} '"$*" >> '${callsPath}'\nexit 1\n`,
      { mode: 0o755 }
    );
  }
  process.env.PATH = `${binDir}:${originalPath}`;
  return { repoPath, callsPath };
}

const readCalls = (callsPath: string): string => (fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "");
const logDir = (repoPath: string): string => path.join(repoPath, ".preflight-test-logs");

afterEach(() => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("missing installed dependencies", () => {
  it("reports npm-test as a skip with an install hint, without running it", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    const result = await runTestChecks(repoPath, { logDir: logDir(repoPath) });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "npm-test", kind: "test", status: "skip" });
    expect(result.checks[0].message).toContain(HINT);
    expect(result.limitations).toEqual([expect.stringContaining(HINT)]);
    expect(readCalls(callsPath)).toBe("");
  });

  it("reports tsc as a skip with an install hint, without running it", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "^5.0.0" } })
    );
    const result = await runTypecheckChecks(repoPath, { logDir: logDir(repoPath) });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "tsc", kind: "typecheck", status: "skip" });
    expect(result.checks[0].message).toContain(HINT);
    expect(result.limitations).toEqual([expect.stringContaining(HINT)]);
    expect(readCalls(callsPath)).toBe("");
  });

  it("reports npm-typecheck and npm-lint the same way", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    const typecheck = await runTypecheckChecks(repoPath, { logDir: logDir(repoPath) });
    const lint = await runLintChecks(repoPath, { logDir: logDir(repoPath) });

    expect(typecheck.checks.map((c) => [c.name, c.status])).toEqual([["npm-typecheck", "skip"]]);
    expect(lint.checks.map((c) => [c.name, c.status])).toEqual([["npm-lint", "skip"]]);
    expect(readCalls(callsPath)).toBe("");
  });

  it("keeps the skipped checks non-failing but makes the default-config run not ready, with one install-hint blocker", async () => {
    const { repoPath } = makeRepo({ installed: false });
    const config = { logDir: logDir(repoPath), checks: { gitState: false, audit: false, secretDetection: false, commitConvention: false, tdd: false } };

    const result = await runPreflight(repoPath, config);
    expect(result.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(result.checks.every((c) => c.status === "skip")).toBe(true);
    expect(result.limitations.filter((l) => l.includes(HINT))).toHaveLength(3);
    expect(result.confidence).toBe(0);
    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain(HINT);
    expect(result.blockers[0]).toContain("npm-test");

    const required = await runPreflight(repoPath, { ...config, requiredChecks: ["test"] });
    expect(required.ready).toBe(false);
    expect(required.blockers.some((b) => b.includes('Required check kind "test"'))).toBe(true);
  });

  it("does not add the install blocker once node_modules exists", async () => {
    const { repoPath } = makeRepo({ installed: true });
    const config = { logDir: logDir(repoPath), checks: { gitState: false, audit: false, secretDetection: false, commitConvention: false, tdd: false } };
    const result = await runPreflight(repoPath, config);
    expect(result.blockers.some((b) => b.includes(HINT))).toBe(false);
  });

  it("runs the checks as before once node_modules exists", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: true });
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath) });
    const typecheck = await runTypecheckChecks(repoPath, { logDir: logDir(repoPath) });
    const lint = await runLintChecks(repoPath, { logDir: logDir(repoPath) });

    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
    expect(typecheck.checks.map((c) => [c.name, c.status])).toEqual([["npm-typecheck", "fail"]]);
    expect(lint.checks.map((c) => [c.name, c.status])).toEqual([["npm-lint", "fail"]]);
    expect(readCalls(callsPath)).toContain("npm run test");
    expect([...test.limitations, ...typecheck.limitations, ...lint.limitations].join("\n")).not.toContain(HINT);
  });

  it("runs the checks as before when the project declares no dependencies", async () => {
    const { repoPath } = makeRepo({ installed: false, dependencies: {} });
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath) });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
  });

  it("runs the checks when --setup is enabled, even before the install exists", async () => {
    const { repoPath } = makeRepo({ installed: false });
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath), setup: { enabled: true } });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
  });

  it("treats a node_modules in an ancestor directory (hoisted workspace install) as installed", async () => {
    const { repoPath } = makeRepo({ installed: true });
    const pkgDir = path.join(repoPath, "packages", "a");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^1.0.0" } })
    );
    const test = await runTestChecks(pkgDir, { logDir: logDir(repoPath) });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
  });
  it("treats a Yarn Plug'n'Play map alone as installed", async () => {
    const { repoPath } = makeRepo({ installed: false });
    fs.writeFileSync(path.join(repoPath, ".pnp.cjs"), "");
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath) });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
    expect(test.limitations.join("\n")).not.toContain(HINT);
  });

  it("names an eslint check with a skip when eslint is declared with a config, no lint script and no install", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ devDependencies: { eslint: "^9.0.0" } })
    );
    fs.writeFileSync(path.join(repoPath, "eslint.config.js"), "export default [];\n");
    const lint = await runLintChecks(repoPath, { logDir: logDir(repoPath) });
    expect(lint.checks).toHaveLength(1);
    expect(lint.checks[0]).toMatchObject({ name: "eslint", kind: "lint", status: "skip" });
    expect(lint.checks[0].message).toContain(HINT);
    expect(readCalls(callsPath)).toBe("");
  });

  it("names a tsc-lint-fallback check with a skip for a tsconfig project without eslint, lint script or install", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "^5.0.0" } })
    );
    const lint = await runLintChecks(repoPath, { logDir: logDir(repoPath) });
    expect(lint.checks).toHaveLength(1);
    expect(lint.checks[0]).toMatchObject({ name: "tsc-lint-fallback", kind: "lint", status: "skip" });
    expect(lint.checks[0].message).toContain(HINT);
    expect(readCalls(callsPath)).toBe("");
  });

  describe("repository boundary", () => {
    it("ignores a node_modules outside the enclosing git repository", async () => {
      const outer = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-missing-deps-outer-"));
      tempDirs.push(outer);
      fs.mkdirSync(path.join(outer, "node_modules"));
      const { repoPath } = makeRepo({ installed: false });
      const inner = path.join(outer, "repo");
      fs.cpSync(repoPath, inner, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: inner });

      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "skip"]]);
      expect(test.limitations.join("\n")).toContain(HINT);
    });

    // A project copied under an outer directory that holds node_modules, with
    // the given content in its own `.git` file (or none when omitted).
    function nestedProject(gitFile?: string): string {
      const outer = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-missing-deps-outer-"));
      tempDirs.push(outer);
      fs.mkdirSync(path.join(outer, "node_modules"));
      const { repoPath } = makeRepo({ installed: false });
      const inner = path.join(outer, "repo");
      fs.cpSync(repoPath, inner, { recursive: true });
      if (gitFile !== undefined) fs.writeFileSync(path.join(inner, ".git"), gitFile);
      return inner;
    }

    it("also stops at a .git file pointing into a worktrees directory (linked worktree)", async () => {
      const inner = nestedProject("gitdir: /somewhere/.git/worktrees/x\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "skip"]]);
      expect(test.limitations.join("\n")).toContain(HINT);
    });

    it("keeps walking past a submodule .git file and uses the superproject install", async () => {
      const inner = nestedProject("gitdir: ../../.git/modules/sub\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
      expect(test.limitations.join("\n")).not.toContain(HINT);

      const result = await runPreflight(inner, {
        logDir: logDir(inner),
        checks: { gitState: false, audit: false, secretDetection: false, commitConvention: false, tdd: false },
      });
      expect(result.blockers.some((b) => b.includes(HINT))).toBe(false);
    });

    it("runs the checks when the .git file is unrecognised", async () => {
      const inner = nestedProject("not a gitdir pointer\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
      expect(test.limitations.join("\n")).not.toContain(HINT);
    });

    it("stops at a linked worktree whose id is `modules`", async () => {
      const inner = nestedProject("gitdir: /somewhere/.git/worktrees/modules\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "skip"]]);
      expect(test.limitations.join("\n")).toContain(HINT);
    });

    it("keeps walking past a submodule named `worktrees`", async () => {
      const inner = nestedProject("gitdir: ../../.git/modules/worktrees\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
      expect(test.limitations.join("\n")).not.toContain(HINT);
    });

    it("keeps walking past a submodule checked out in a linked worktree of its superproject", async () => {
      const inner = nestedProject("gitdir: ../../sup/.git/worktrees/wt1/modules/mysub\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
      expect(test.limitations.join("\n")).not.toContain(HINT);
    });

    it("stops at a linked worktree of a submodule", async () => {
      const inner = nestedProject("gitdir: /somewhere/.git/modules/sub/worktrees/wt\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "skip"]]);
      expect(test.limitations.join("\n")).toContain(HINT);
    });

    it("reads a Windows-style backslash gitdir", async () => {
      const inner = nestedProject("gitdir: C:\\work\\repo\\.git\\worktrees\\modules\n");
      const test = await runTestChecks(inner, { logDir: logDir(inner) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "skip"]]);
      expect(test.limitations.join("\n")).toContain(HINT);
    });

    it("counts a node_modules hoisted to the repository root for a nested package", async () => {
      const { repoPath } = makeRepo({ installed: true });
      execFileSync("git", ["init", "-q"], { cwd: repoPath });
      const pkgDir = path.join(repoPath, "packages", "a");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^1.0.0" } })
      );
      const test = await runTestChecks(pkgDir, { logDir: logDir(repoPath) });
      expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
      expect(test.limitations.join("\n")).not.toContain(HINT);
    });
  });

  describe("not-installed marker", () => {
    it("recognises only results built by dependenciesNotInstalledResult", () => {
      const built = dependenciesNotInstalledResult("npm-test", "test", 0.2).check;
      expect(isDependenciesNotInstalled(built)).toBe(true);
      // A skip that only quotes the hint text must not add an install blocker.
      expect(isDependenciesNotInstalled({ ...built })).toBe(false);
      expect(isDependenciesNotInstalled({ name: "x", kind: "test", status: "skip", message: `x: ${HINT}`, durationMs: 0, confidenceContribution: 0 })).toBe(false);
    });
  });
});

describe("classifyGitdir", () => {
  it.each([
    ["/r/.git/worktrees/x", "worktree"],
    ["/r/.git/worktrees/modules", "worktree"],
    ["/r/.git/worktrees/x/", "worktree"],
    ["/srv/bare.git/worktrees/x", "worktree"],
    ["/r/.git/modules/sub/worktrees/wt", "worktree"],
    ["/r/.git/modules/worktrees/worktrees/wt", "worktree"],
    ["C:\\r\\.git\\worktrees\\modules", "worktree"],
    ["../../.git/modules/sub", "submodule"],
    ["../../.git/modules/worktrees", "submodule"],
    ["/r/.git/modules/a/modules/b", "submodule"],
    ["./.git/modules/libs/x", "submodule"],
    ["C:\\r\\.git\\modules\\worktrees", "submodule"],
    ["/r/.git/worktrees/wt1/modules/sub", "submodule"],
    ["../../sup/.git/worktrees/wt1/modules/worktrees", "submodule"],
    ["/srv/repo.git/modules/n", "submodule"],
    ["/srv/repo.git/modules/a/modules/b", "submodule"],
    ["/r/.git/worktrees/wt1/modules", "unknown"],
    ["/r/notgit/modules/sub", "unknown"],
    ["/r/.git/modules", "unknown"],
    ["/r/.git", "unknown"],
    ["/r/modules/sub", "unknown"],
    ["", "unknown"],
  ] as const)("%s -> %s", (gitdir, expected) => {
    expect(classifyGitdir(gitdir)).toBe(expected);
  });
});
