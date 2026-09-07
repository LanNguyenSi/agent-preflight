import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { runPreflight } from "../src/runner.js";

// Reproduction for the tracker's `--setup` vs `clean-worktree` interaction
// (task b16ab5d8): a fixture whose build writes a non-gitignored output
// directory (tests/fixtures/monorepo-build-required has no .gitignore, so
// `packages/needs-build/dist/` lands untracked) must not let `--setup`
// blame the tool's own build output for a dirty worktree. Reuses the same
// fixture and `withFixture`-style copy pattern as
// tests/build-required.test.ts, duplicated locally (that file does not
// export its helpers) rather than sharing state across test files.
const FIXTURES_ROOT = path.join(__dirname, "fixtures");

function copyFixtureToTmp(fixtureName: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-${fixtureName}-cw-`));
  fs.cpSync(path.join(FIXTURES_ROOT, fixtureName), tmpRoot, { recursive: true, verbatimSymlinks: true });
  execSync("git init -q", { cwd: tmpRoot });
  execSync('git config user.email "t@example.com"', { cwd: tmpRoot });
  execSync('git config user.name "T"', { cwd: tmpRoot });
  execSync("git add .", { cwd: tmpRoot });
  execSync('git commit -qm "init"', { cwd: tmpRoot });
  return tmpRoot;
}

async function withFixture<T>(fixtureName: string, body: (repoPath: string, logDir: string) => Promise<T>): Promise<T> {
  const repoPath = copyFixtureToTmp(fixtureName);
  try {
    return await body(repoPath, path.join(repoPath, ".preflight-test-logs"));
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

// Only the checks relevant to this feature: git-state (under test) plus the
// test check, so the build's effect on the workspace is still observable.
// Everything else would only add noise.
const CLEAN_WORKTREE_CHECKS = {
  gitState: true,
  lint: false,
  typecheck: false,
  test: false,
  audit: false,
  secretDetection: false,
  commitConvention: false,
  ciSimulation: false,
  tdd: false,
} as const;

function cleanWorktreeCheckOf(result: { checks: { kind: string; name: string; status: string; message?: string; details?: string[] }[] }) {
  return result.checks.find((check) => check.name === "clean-worktree");
}

describe("clean-worktree under --setup (fixture: monorepo-build-required)", () => {
  it("passes and reports ready:true when the worktree was clean before setup, naming the untracked build output as a note/limitation instead of a blocker", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist"))).toBe(false);

      const result = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      // Setup really did produce untracked output (otherwise this test
      // proves nothing about the interaction under test).
      expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist", "index.js"))).toBe(true);

      const check = cleanWorktreeCheckOf(result);
      expect(check?.status).toBe("pass");
      expect(result.blockers).toEqual([]);
      expect(result.ready).toBe(true);

      // The untracked output is named somewhere on the check itself...
      const checkText = `${check?.message ?? ""} ${(check?.details ?? []).join(" ")}`;
      // ...or as a limitation -- either satisfies "named in a limitation or
      // a check note, not as a blocker" (tracker criterion 1).
      const limitationText = result.limitations.join(" ");
      const namesSetupOutput = /needs-build.dist/.test(checkText) || /needs-build.dist/.test(limitationText);
      expect(namesSetupOutput).toBe(true);
    });
  });

  it("F1: still fails clean-worktree under --setup when the build rewrites a TRACKED file (committed dist/index.js), naming that setup modified it", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      // Commit a stale dist/index.js as if it had been checked in
      // deliberately (or left over from a previous, un-gitignored build).
      // The fixture's build.js always overwrites this file with different
      // content, so once `--setup` reruns the build this tracked file
      // changes under git's feet -- untracked-output logic must not
      // excuse that (review finding F1).
      const distDir = path.join(repoPath, "packages", "needs-build", "dist");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, "index.js"), "module.exports = { hello: () => \"stale\" };\n", "utf8");
      execSync("git add packages/needs-build/dist/index.js", { cwd: repoPath });
      execSync('git commit -qm "checked-in stale dist"', { cwd: repoPath });

      const result = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      // The build really did rewrite the tracked file's content (otherwise
      // this test proves nothing about the interaction under test).
      const rebuilt = fs.readFileSync(path.join(distDir, "index.js"), "utf8");
      expect(rebuilt).not.toContain("stale");

      const check = cleanWorktreeCheckOf(result);
      expect(check?.status).toBe("fail");
      expect(check?.message).toBe("--setup modified or removed tracked files");
      expect(result.ready).toBe(false);
      expect(result.blockers).toContain("--setup modified or removed tracked files");

      const checkText = `${check?.message ?? ""} ${(check?.details ?? []).join(" ")}`;
      expect(checkText).toContain("needs-build");
      expect(checkText).not.toContain(".gitignore");
    });
  });

  it("still fails clean-worktree under --setup when the worktree was dirty BEFORE setup ran (negative control)", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      // Dirty a tracked file before setup runs at all.
      fs.appendFileSync(path.join(repoPath, "package.json"), "\n");

      const result = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      const check = cleanWorktreeCheckOf(result);
      expect(check?.status).toBe("fail");
      expect(check?.message).toBe("Repository has uncommitted changes");
      expect(result.ready).toBe(false);
      expect(result.blockers).toContain("Repository has uncommitted changes");
    });
  });

  it("still fails clean-worktree the same way WITHOUT --setup, on the same kind of pre-existing dirt (negative control, both states)", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      fs.appendFileSync(path.join(repoPath, "package.json"), "\n");

      const result = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        // setup not enabled at all
      });

      const check = cleanWorktreeCheckOf(result);
      expect(check?.status).toBe("fail");
      expect(check?.message).toBe("Repository has uncommitted changes");
      expect(result.ready).toBe(false);
    });
  });
});
