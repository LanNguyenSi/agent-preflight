import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { runTddCheck } from "../src/checks/tdd.js";
import { runPreflight } from "../src/runner.js";
import type { PreflightConfig } from "../src/types.js";

let tmpDir: string;

function initRepo(files: Record<string, string>) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-"));
  fs.mkdirSync(path.join(tmpDir, ".git"));

  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Initialize a real git repo with user config (needed in CI where no global git identity exists) */
async function initGitRepo() {
  const { execa } = await import("execa");
  fs.rmSync(path.join(tmpDir, ".git"), { recursive: true });
  await execa("git", ["init"], { cwd: tmpDir });
  await execa("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
  await execa("git", ["config", "user.name", "Test"], { cwd: tmpDir });
}

async function commitFiles(files: Record<string, string>, message: string) {
  const { execa } = await import("execa");
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  await execa("git", ["add", "."], { cwd: tmpDir });
  await execa("git", ["commit", "-m", message, "--no-gpg-sign"], { cwd: tmpDir });
}

function tddOnlyConfig(workingDir?: string): PreflightConfig {
  return {
    workingDir,
    checks: {
      gitState: false, lint: false, typecheck: false, test: false, audit: false,
      ciSimulation: false, commitConvention: false, secretDetection: false, tdd: true,
    },
  };
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const defaultConfig: PreflightConfig = {};

describe("runTddCheck", () => {
  it("passes when no source files changed", async () => {
    initRepo({});
    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("pass");
  });

  it("skips with a limitation when only non-.ts/.js files changed", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({ "src/Service.php": "<?php class Service {}" }, "add php");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("skip");
    expect(result.limitations.join("\n")).toContain("tdd-test-counterpart");
  });

  it("reports an untested source added in the first of two branch commits", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    const { stdout: defaultBranch } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmpDir });
    expect(["main", "master"]).toContain(defaultBranch.trim());
    await execa("git", ["checkout", "-b", "feature"], { cwd: tmpDir });
    await commitFiles({ "src/first.ts": "export const first = 1;" }, "add first");
    await commitFiles({ "docs/notes.md": "notes" }, "add notes");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toContain("src/first.ts");
  });

  it("reports an uncommitted untested source change", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "src/old.ts": "export const old = 1;", "src/old.test.ts": "test('o', () => {});" }, "init");
    await commitFiles({ "README.md": "# x" }, "docs");
    fs.writeFileSync(path.join(tmpDir, "src/fresh.ts"), "export const fresh = 1;");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toContain("src/fresh.ts");
  });

  it("does not treat a deleted source file as needing a test", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await commitFiles({ "src/gone.ts": "export const gone = 1;" }, "init");
    await execa("git", ["checkout", "-b", "feature"], { cwd: tmpDir });
    await execa("git", ["rm", "-q", "src/gone.ts"], { cwd: tmpDir });
    await execa("git", ["commit", "-q", "-m", "remove gone", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].details).toBeUndefined();
  });

  describe("when HEAD does not diverge from its base", () => {
    async function git(args: string[], cwd = tmpDir) {
      const { execa } = await import("execa");
      return execa("git", args, { cwd });
    }

    async function cloneOfBare(): Promise<string> {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      await git(["init", "--bare", "-q", bare], bare);
      initRepo({});
      await initGitRepo();
      await git(["checkout", "-q", "-b", "main"]);
      await commitFiles({ "README.md": "# x" }, "init");
      await git(["remote", "add", "origin", bare]);
      await git(["push", "-q", "-u", "origin", "main"]);
      return bare;
    }

    it("flags an untested source in the commit that was just pushed on main", async () => {
      const bare = await cloneOfBare();
      try {
        await commitFiles({ "src/a.ts": "export const a = 1;" }, "add a");
        await git(["push", "-q", "origin", "main"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toContain("src/a.ts");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("flags an untested source on a feature branch pushed with -u", async () => {
      const bare = await cloneOfBare();
      try {
        await git(["checkout", "-q", "-b", "feature"]);
        await commitFiles({ "src/b.ts": "export const b = 1;" }, "add b");
        await git(["push", "-q", "-u", "origin", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toContain("src/b.ts");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("flags an untested source when local main is one commit ahead of origin/main", async () => {
      const bare = await cloneOfBare();
      try {
        await commitFiles({ "src/c.ts": "export const c = 1;" }, "add c");
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toContain("src/c.ts");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  it("warns when source file has no test counterpart", async () => {
    initRepo({
      "src/foo.ts": "export const foo = 1;",
    });

    // Create a real git repo so git diff works
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd: tmpDir });

    // Add a new file without test
    fs.writeFileSync(path.join(tmpDir, "src/bar.ts"), "export const bar = 2;");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add bar", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toContain("src/bar.ts");
  });

  it("passes when source file has test counterpart", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/foo.ts"), "export const foo = 1;");
    fs.writeFileSync(path.join(tmpDir, "src/foo.test.ts"), "test('foo', () => {});");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add foo with test", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
  });

  it("skips exception files like index.ts", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/index.ts"), "export {};");
    fs.writeFileSync(path.join(tmpDir, "src/types.ts"), "export type Foo = string;");
    fs.writeFileSync(path.join(tmpDir, "src/constants.ts"), "export const X = 1;");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add exceptions", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].message).toContain("No checkable");
  });

  it("supports configurable exceptions", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/helpers.ts"), "export const h = 1;");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add helpers", "--no-gpg-sign"], { cwd: tmpDir });

    const config: PreflightConfig = { tddExceptions: ["helpers.ts"] };
    const result = await runTddCheck(tmpDir, config);
    expect(result.checks[0].status).toBe("pass");
  });

  it("finds tests in __tests__ directory", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src/__tests__"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/foo.ts"), "export const foo = 1;");
    fs.writeFileSync(path.join(tmpDir, "src/__tests__/foo.test.ts"), "test('foo', () => {});");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add foo", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
  });

  it("rebases changed sources and tests to a nested target for direct and runner calls", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({
      "packages/a/src/foo.ts": "export const foo = 1;",
      "packages/a/tests/foo.test.ts": "test('foo', () => {});",
      "packages/b/src/foo.ts": "export const foo = 1;",
      "packages/b/tests/foo.test.ts": "test('foo', () => {});",
    }, "initial packages");
    await commitFiles({
      "packages/a/src/foo.ts": "export const foo = 2;",
      "packages/a/tests/foo.test.ts": "test('foo', () => { expect(true).toBe(true); });",
      "packages/b/src/foo.ts": "export const foo = 2;",
    }, "change sources");

    const target = path.join(tmpDir, "packages/a");
    expect((await runTddCheck(target, defaultConfig)).checks[0].status).toBe("pass");
    // logdir-guard: tddOnlyConfig() only enables checks.tdd, and tdd.ts
    // never calls runShellCheck/persistFailureOutput.
    expect((await runPreflight(tmpDir, tddOnlyConfig("packages/a"))).checks.find((check) => check.kind === "tdd")?.status).toBe("pass");
  });

  it("excludes sibling and prefix paths, and a sibling test cannot satisfy a missing target test", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({
      "packages/a/src/foo.ts": "export const foo = 1;",
      "packages/a-other/src/ignored.ts": "export const ignored = 1;",
      "packages/b/src/foo.ts": "export const foo = 1;",
      "packages/b/tests/foo.test.ts": "test('foo', () => {});",
    }, "initial packages");
    await commitFiles({
      "packages/a/src/foo.ts": "export const foo = 2;",
      "packages/a-other/src/ignored.ts": "export const ignored = 2;",
      "packages/b/src/foo.ts": "export const foo = 2;",
    }, "change sources");

    const result = await runTddCheck(path.join(tmpDir, "packages/a"), defaultConfig);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toEqual(["src/foo.ts"]);
  });

  it.each(["remove", "rename"])("warns when a target counterpart is %s and its source changes", async (operation) => {
    initRepo({});
    await initGitRepo();
    await commitFiles({
      "packages/a/src/foo.ts": "export const foo = 1;",
      "packages/a/tests/foo.test.ts": "test('foo', () => {});",
    }, "initial package");
    const counterpart = path.join(tmpDir, "packages/a/tests/foo.test.ts");
    if (operation === "remove") fs.rmSync(counterpart);
    else fs.renameSync(counterpart, path.join(tmpDir, "packages/a/tests/foo-renamed.test.ts"));
    await commitFiles({ "packages/a/src/foo.ts": "export const foo = 2;" }, `${operation} counterpart and change source`);

    const result = await runTddCheck(path.join(tmpDir, "packages/a"), defaultConfig);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toEqual(["src/foo.ts"]);
  });

  it("supports a target path with spaces and a linked worktree", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({
      "packages/a space/src/foo.ts": "export const foo = 1;",
      "packages/a space/src/foo.spec.ts": "test('foo', () => {});",
    }, "initial package");
    const worktree = `${tmpDir}-linked`;
    const { execa } = await import("execa");
    await execa("git", ["branch", "linked-test"], { cwd: tmpDir });
    await execa("git", ["worktree", "add", worktree, "linked-test"], { cwd: tmpDir });
    try {
      fs.writeFileSync(path.join(worktree, "packages/a space/src/foo.ts"), "export const foo = 2;");
      await execa("git", ["add", "."], { cwd: worktree });
      await execa("git", ["commit", "-m", "change source", "--no-gpg-sign"], { cwd: worktree });
      expect((await runTddCheck(path.join(worktree, "packages/a space"), defaultConfig)).checks[0].status).toBe("pass");
    } finally {
      await execa("git", ["worktree", "remove", "--force", worktree], { cwd: tmpDir });
    }
  });
});
