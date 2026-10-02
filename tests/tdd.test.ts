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

  it("ignores a source file deleted in the working tree when no base resolves", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await commitFiles({ "src/gone.ts": "export const gone = 1;" }, "init");
    await commitFiles({ "README.md": "# x" }, "docs");
    await execa("git", ["rm", "-q", "src/gone.ts"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).not.toBe("warn");
    expect(result.checks[0].details).toBeUndefined();
  });

  it("reports an uncommitted modification of a tracked source when no base resolves", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "src/old.ts": "export const old = 1;" }, "init");
    await commitFiles({ "README.md": "# x" }, "docs");
    fs.writeFileSync(path.join(tmpDir, "src/old.ts"), "export const old = 2;");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toEqual(["src/old.ts"]);
  });

  it("ignores a source deletion committed in HEAD when no base resolves", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await commitFiles({ "src/gone.ts": "export const gone = 1;" }, "init");
    await execa("git", ["rm", "-q", "src/gone.ts"], { cwd: tmpDir });
    await execa("git", ["commit", "-q", "-m", "remove gone", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].details).toBeUndefined();
  });

  it("names an untested source whose path has spaces and non-ASCII characters", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({ "src/sp ace/ü né.ts": "export const a = 1;" }, "add unicode");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toEqual(["src/sp ace/ü né.ts"]);
  });

  it("passes, not skips, when only test files changed", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({ "src/foo.test.ts": "test('foo', () => {});" }, "add test only");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.limitations).toEqual([]);
  });

  it("passes, not skips, when only configured exception files changed", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({ "src/helpers.ts": "export const h = 1;" }, "add helpers");

    const result = await runTddCheck(tmpDir, { tddExceptions: ["helpers.ts"] });
    expect(result.checks[0].status).toBe("pass");
    expect(result.limitations).toEqual([]);
  });

  it("skips with a limitation for docs-only changes", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({ "README.md": "# y", "docs/a.md": "a" }, "docs");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("skip");
    expect(result.checks[0].message).not.toContain("other languages");
    expect(result.limitations.join("\n")).toContain("2 changed file(s)");
  });

  it("keeps the verdict for .ts files but adds a limitation when a PHP file changed alongside", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({
      "src/t.ts": "export const t = 1;",
      "src/t.test.ts": "test('t', () => {});",
      "src/S.php": "<?php class S {}",
    }, "mixed");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).toContain("tdd-test-counterpart");
    expect(result.limitations[0]).toContain("other file types not checked");
  });

  it("passes without limitations in a repository with no commits and no files", async () => {
    initRepo({});
    await initGitRepo();

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.limitations).toEqual([]);
  });

  it("adds no limitation when a tested .ts file changes together with a docs file", async () => {
    initRepo({});
    await initGitRepo();
    await commitFiles({ "README.md": "# x" }, "init");
    await commitFiles({
      "src/t.ts": "export const t = 1;",
      "src/t.test.ts": "test('t', () => {});",
      "docs/a.md": "a",
    }, "tested change with docs");

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.limitations).toEqual([]);
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

    it("ignores a source file deleted by the last commit when HEAD equals origin/main", async () => {
      const bare = await cloneOfBare();
      try {
        await commitFiles({ "src/gone.ts": "export const gone = 1;" }, "add gone");
        await git(["push", "-q", "origin", "main"]);
        await git(["rm", "-q", "src/gone.ts"]);
        await git(["commit", "-q", "-m", "remove gone", "--no-gpg-sign"]);
        await git(["push", "-q", "origin", "main"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("pass");
        expect(result.checks[0].details).toBeUndefined();
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("skips with a limitation when a pushed root commit leaves no diff range to examine", async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["checkout", "-q", "-b", "main"]);
        await commitFiles({ "src/a.ts": "export const a = 1;" }, "root");
        await git(["remote", "add", "origin", bare]);
        await git(["push", "-q", "-u", "origin", "main"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("skip");
        expect(result.limitations.join("\n")).toContain("diff range could not be determined");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("skips with a limitation on a shallow clone whose only visible commit has no parent", async () => {
      const bare = await cloneOfBare();
      const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-shallow-"));
      try {
        await commitFiles({ "src/a.ts": "export const a = 1;" }, "add a");
        await git(["push", "-q", "origin", "main"]);
        fs.rmSync(shallow, { recursive: true, force: true });
        await git(["clone", "-q", "--depth", "1", `file://${bare}`, shallow], os.tmpdir());
        const result = await runTddCheck(shallow, defaultConfig);
        expect(result.checks[0].status).toBe("skip");
        expect(result.limitations.join("\n")).toContain("diff range could not be determined");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
        fs.rmSync(shallow, { recursive: true, force: true });
      }
    });

    it("flags an untested source from the first of two commits on a feature branch pushed with -u", async () => {
      const bare = await cloneOfBare();
      try {
        await git(["checkout", "-q", "-b", "feature"]);
        await commitFiles({ "src/first.ts": "export const first = 1;" }, "add first");
        await commitFiles({ "src/b.ts": "export const b = 1;", "src/b.test.ts": "test('b', () => {});" }, "add b with test");
        await git(["push", "-q", "-u", "origin", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
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

    it("adds the unknown-range limitation on a shallow clone even when other changes are visible", async () => {
      const bare = await cloneOfBare();
      const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-shallow-"));
      try {
        await commitFiles({ "src/b.ts": "export const b = 1;" }, "add b");
        await git(["push", "-q", "origin", "main"]);
        fs.rmSync(shallow, { recursive: true, force: true });
        await git(["clone", "-q", "--depth", "1", `file://${bare}`, shallow], os.tmpdir());
        fs.writeFileSync(path.join(shallow, "src/a.ts"), "export const a = 1;");
        fs.writeFileSync(path.join(shallow, "src/a.test.ts"), "test('a', () => {});");
        const result = await runTddCheck(shallow, defaultConfig);
        expect(result.checks[0].status).toBe("pass");
        expect(result.limitations.join("\n")).toContain("diff range could not be determined");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
        fs.rmSync(shallow, { recursive: true, force: true });
      }
    });

    it("ignores a source deleted on a feature branch pushed with -u", async () => {
      const bare = await cloneOfBare();
      try {
        await commitFiles({ "src/x.ts": "export const x = 1;" }, "add x");
        await git(["push", "-q", "origin", "main"]);
        await git(["checkout", "-q", "-b", "feature"]);
        await git(["rm", "-q", "src/x.ts"]);
        await git(["commit", "-q", "-m", "remove x", "--no-gpg-sign"]);
        await git(["push", "-q", "-u", "origin", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("pass");
        expect(result.checks[0].details).toBeUndefined();
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("compares against the nearest default branch, not a stale fork origin/main", async () => {
      const fork = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-fork-"));
      const up = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-up-"));
      try {
        await git(["init", "--bare", "-q", fork], fork);
        await git(["init", "--bare", "-q", up], up);
        initRepo({});
        await initGitRepo();
        await git(["checkout", "-q", "-b", "main"]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "origin", fork]);
        await git(["push", "-q", "-u", "origin", "main"]);
        await git(["remote", "add", "upstream", up]);
        await git(["checkout", "-q", "-b", "tmp"]);
        await commitFiles({ "src/other.ts": "export const other = 1;" }, "upstream: other");
        await git(["push", "-q", "upstream", "tmp:main"]);
        await git(["checkout", "-q", "main"]);
        await git(["branch", "-q", "-D", "tmp"]);
        await git(["fetch", "-q", "upstream"]);
        await git(["checkout", "-q", "-b", "feature", "upstream/main"]);
        await commitFiles({ "src/t.ts": "export const t = 1;", "src/t.test.ts": "test('t', () => {});" }, "tested change");
        await git(["push", "-q", "-u", "origin", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("pass");
        expect(result.checks[0].details).toBeUndefined();
      } finally {
        fs.rmSync(fork, { recursive: true, force: true });
        fs.rmSync(up, { recursive: true, force: true });
      }
    });

    it("compares against origin/main, not a leftover origin/HEAD and origin/master", async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["checkout", "-q", "-b", "main"]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "origin", bare]);
        await git(["push", "-q", "origin", "main:master"]);
        await git(["remote", "set-head", "origin", "master"]);
        await commitFiles({ "src/other.ts": "export const other = 1;" }, "other");
        await git(["push", "-q", "origin", "main"]);
        await git(["checkout", "-q", "-b", "feature"]);
        await commitFiles({ "src/t.ts": "export const t = 1;", "src/t.test.ts": "test('t', () => {});" }, "tested change");
        await git(["push", "-q", "-u", "origin", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("pass");
        expect(result.checks[0].details).toBeUndefined();
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    async function twoCommitFeature(remote: string): Promise<void> {
      await git(["checkout", "-q", "-b", "feature"]);
      await commitFiles({ "src/first.ts": "export const first = 1;" }, "add first");
      await commitFiles({ "docs/notes.md": "notes" }, "add notes");
      await git(["push", "-q", "-u", remote, "feature"]);
    }

    it("skips an origin/HEAD that points at the current branch", async () => {
      const bare = await cloneOfBare();
      try {
        await twoCommitFeature("origin");
        await git(["remote", "set-head", "origin", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("skips an origin/HEAD that points at the upstream when a further local commit follows it", async () => {
      const bare = await cloneOfBare();
      try {
        await twoCommitFeature("origin");
        await git(["remote", "set-head", "origin", "feature"]);
        await commitFiles({ "docs/more.md": "more" }, "add more notes");
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("skips a local main whose merge base is HEAD and uses origin/main", async () => {
      const bare = await cloneOfBare();
      try {
        await twoCommitFeature("origin");
        await git(["branch", "-f", "main", "feature"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("uses the default branch of a remote not named origin", async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["checkout", "-q", "-b", "main"]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "gh", bare]);
        await git(["push", "-q", "-u", "gh", "main"]);
        await twoCommitFeature("gh");
        await git(["branch", "-q", "-D", "main"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("uses origin/HEAD for a default branch named develop", async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["checkout", "-q", "-b", "develop"]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "origin", bare]);
        await git(["push", "-q", "-u", "origin", "develop"]);
        await git(["remote", "set-head", "origin", "develop"]);
        await twoCommitFeature("origin");
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
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

    it("flags every unpushed commit on main, not only the last one", async () => {
      const bare = await cloneOfBare();
      try {
        await commitFiles({ "src/c.ts": "export const c = 1;" }, "add c");
        await commitFiles({ "docs/notes.md": "notes" }, "add notes");
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/c.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("flags every unpushed commit on a default branch named develop", async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["symbolic-ref", "HEAD", "refs/heads/develop"]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "origin", bare]);
        await git(["push", "-q", "-u", "origin", "develop"]);
        await git(["remote", "set-head", "origin", "develop"]);
        await commitFiles({ "src/first.ts": "export const first = 1;" }, "add first");
        await commitFiles({ "docs/notes.md": "notes" }, "add notes");
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it.each(["pulled into local main", "branched with --no-track from upstream/main"])(
      "compares a fork clone with a stale origin/HEAD against upstream/main (%s)",
      async (layout) => {
        initRepo({});
        await initGitRepo();
        await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
        await commitFiles({ "README.md": "# x" }, "init");
        const up = `${tmpDir}-up.git`;
        const fork = `${tmpDir}-fork.git`;
        try {
          await git(["clone", "-q", "--bare", tmpDir, up], os.tmpdir());
          await git(["clone", "-q", "--bare", tmpDir, fork], os.tmpdir());
          await commitFiles({ "src/other.ts": "export const other = 1;" }, "upstream: other");
          await git(["push", "-q", up, "main"]);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          await git(["clone", "-q", fork, tmpDir], os.tmpdir());
          await git(["config", "user.email", "test@test.com"]);
          await git(["config", "user.name", "Test"]);
          await git(["remote", "add", "upstream", up]);
          if (layout === "pulled into local main") {
            await git(["pull", "-q", "--ff-only", "upstream", "main"]);
            await git(["checkout", "-q", "-b", "feature"]);
          } else {
            await git(["fetch", "-q", "upstream"]);
            await git(["checkout", "-q", "--no-track", "-b", "feature", "upstream/main"]);
          }
          expect((await git(["symbolic-ref", "refs/remotes/origin/HEAD"])).stdout).toBe("refs/remotes/origin/main");
          await commitFiles({ "src/t.ts": "export const t = 1;", "src/t.test.ts": "test('t', () => {});" }, "tested change");
          const result = await runTddCheck(tmpDir, defaultConfig);
          expect(result.checks[0].status).toBe("pass");
          expect(result.checks[0].details).toBeUndefined();
        } finally {
          fs.rmSync(up, { recursive: true, force: true });
          fs.rmSync(fork, { recursive: true, force: true });
        }
      },
    );

    it.each(["main", "feature"])("does not trust a local main that holds the branch's first commit (origin/HEAD at %s)", async (head) => {
      const bare = await cloneOfBare();
      try {
        await commitFiles({ "src/first.ts": "export const first = 1;" }, "add first");
        await git(["checkout", "-q", "-b", "feature"]);
        await commitFiles({ "docs/notes.md": "notes" }, "add notes");
        await git(["push", "-q", "-u", "origin", "feature"]);
        await git(["remote", "set-head", "origin", head]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it.each(["main", "master"])("uses a local %s whose commits are all on a remote", async (name) => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["symbolic-ref", "HEAD", `refs/heads/${name}`]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "gh", bare]);
        await git(["push", "-q", "gh", `${name}:release`]);
        await twoCommitFeature("gh");
        const refs = await git(["for-each-ref", "--format=%(refname)", "refs/remotes"]);
        expect(refs.stdout.split("\n")).toEqual(["refs/remotes/gh/feature", "refs/remotes/gh/release"]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("uses <remote>/master when the remote has no HEAD and there is no local master", async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-bare-"));
      try {
        await git(["init", "--bare", "-q", bare], bare);
        initRepo({});
        await initGitRepo();
        await git(["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        await commitFiles({ "README.md": "# x" }, "init");
        await git(["remote", "add", "origin", bare]);
        await git(["push", "-q", "origin", "trunk:master"]);
        await git(["fetch", "-q", "origin"]);
        await git(["checkout", "-q", "--detach", "origin/master"]);
        await git(["branch", "-q", "-D", "trunk"]);
        await git(["update-ref", "-d", "--no-deref", "refs/remotes/origin/HEAD"]);
        await twoCommitFeature("origin");
        const refs = await git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
        expect(refs.stdout.split("\n")).toEqual([
          "refs/heads/feature", "refs/remotes/origin/feature", "refs/remotes/origin/master",
        ]);
        const result = await runTddCheck(tmpDir, defaultConfig);
        expect(result.checks[0].status).toBe("warn");
        expect(result.checks[0].details).toEqual(["src/first.ts"]);
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
