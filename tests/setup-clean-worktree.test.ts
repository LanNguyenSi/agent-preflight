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

  // task b16ab5d8, review round 3, finding N1: the fix above only holds
  // for the FIRST --setup run in a worktree. If the un-gitignored setup
  // output from run 1 is still there (nobody added it to .gitignore),
  // run 2's PRE-setup snapshot already contains it, so it reads as
  // pre-existing dirt on run 2 and blocks -- correctly (the tool cannot
  // tell run-1 leftovers from a real user change), but D-011 says the
  // failure should name the paths and point at .gitignore instead of the
  // old undifferentiated message.
  it("N1: a second --setup run against still-un-gitignored output from run 1 fails naming the paths and the .gitignore remedy (run 1 stays a pass)", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      const distIndex = path.join(repoPath, "packages", "needs-build", "dist", "index.js");

      const run1 = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });
      expect(fs.existsSync(distIndex)).toBe(true);
      const check1 = cleanWorktreeCheckOf(run1);
      expect(check1?.status).toBe("pass");
      expect(run1.ready).toBe(true);

      // No user change between the two runs, and dist/ is still not
      // gitignored -- exactly the "left un-ignored" case D-011 covers.
      const run2 = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      const check2 = cleanWorktreeCheckOf(run2);
      expect(check2?.status).toBe("fail");
      expect(run2.ready).toBe(false);
      const text2 = `${(check2?.details ?? []).join(" ")} ${run2.limitations.join(" ")}`;
      expect(text2).toContain("needs-build");
      expect(text2).toContain("dist");
      expect(text2.toLowerCase()).toContain(".gitignore");
    });
  });

  // Control for N1, in the same two-run shape: a pre-existing TRACKED
  // change (not the untracked-only case N1 covers) still yields today's
  // undifferentiated message on run 2, with no .gitignore remedy --
  // already pinned directly against runGitStateChecks by
  // tests/git-state.test.ts's "N2" and pre-existing-tracked tests; pinned
  // here too through the actual --setup wiring, since that's the surface
  // N1 changed.
  it("control: a pre-existing TRACKED modification before a second --setup run still yields the old undifferentiated message, no .gitignore remedy", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      const run1 = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });
      expect(cleanWorktreeCheckOf(run1)?.status).toBe("pass");

      // Dirty a tracked file before the second --setup run.
      fs.appendFileSync(path.join(repoPath, "package.json"), "\n");

      const run2 = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      const check2 = cleanWorktreeCheckOf(run2);
      expect(check2?.status).toBe("fail");
      expect(check2?.message).toBe("Repository has uncommitted changes");
      expect(check2?.details).toEqual([
        "Commit or stash changes before relying on preflight results for a push",
      ]);
      expect(run2.ready).toBe(false);
    });
  });

  it("a pre-existing untracked DIRECTORY (collapsed '?? dir/' in both the snapshot and the current state) is treated as pre-existing dirt and fails, naming the directory", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      // Simulate a leftover un-gitignored dist/ directory that predates
      // this run entirely (not something --setup itself produces this
      // time): git reports a not-yet-tracked directory as a single
      // collapsed "?? dir/" entry, both before and after --setup runs,
      // rather than per-file. Conservative reading: this is pre-existing
      // dirt (blocks), not "--setup produced it fresh" (would pass),
      // since the directory already existed before the run started.
      const distDir = path.join(repoPath, "packages", "needs-build", "dist");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, "stale.txt"), "leftover\n", "utf8");

      const result = await runPreflight(repoPath, {
        checks: CLEAN_WORKTREE_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      const check = cleanWorktreeCheckOf(result);
      expect(check?.status).toBe("fail");
      expect(result.ready).toBe(false);
      const text = `${(check?.details ?? []).join(" ")} ${result.limitations.join(" ")}`;
      expect(text).toContain("needs-build");
      expect(text).toContain("dist");
    });
  });
});
