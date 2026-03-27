import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { runGitStateChecks } from "../src/checks/git.js";
import { defaultConfig } from "../src/config.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initGitRepo(repoPath: string): void {
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n", "utf8");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "feat: initial commit"]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("git state checks", () => {
  it("passes on a clean feature branch", async () => {
    const repoPath = makeTempDir("preflight-git-state-clean-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.limitations).toEqual([]);
    expect(result.checks.find((check) => check.name === "protected-branch")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "clean-worktree")?.status).toBe("pass");
  });

  it("warns on a protected branch", async () => {
    const repoPath = makeTempDir("preflight-git-state-protected-");
    initGitRepo(repoPath);
    git(repoPath, ["branch", "-M", "main"]);

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.checks.find((check) => check.name === "protected-branch")?.status).toBe("warn");
    expect(result.checks.find((check) => check.name === "protected-branch")?.message).toContain(
      'Repository is on protected branch "main"'
    );
  });

  it("fails when the worktree is dirty", async () => {
    const repoPath = makeTempDir("preflight-git-state-dirty-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "notes.txt"), "dirty\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.checks.find((check) => check.name === "clean-worktree")?.status).toBe("fail");
    expect(result.checks.find((check) => check.name === "clean-worktree")?.message).toBe(
      "Repository has uncommitted changes"
    );
  });

  it("returns a limitation for non-git directories", async () => {
    const repoPath = makeTempDir("preflight-git-state-non-git-");

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.checks).toEqual([]);
    expect(result.limitations).toContain("Not a git repository; git state checks skipped");
  });
});
