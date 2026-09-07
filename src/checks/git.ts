import { execa } from "execa";
import { CheckResult, PreflightConfig } from "../types.js";
import { CheckSetResult } from "./shared.js";

const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

// How many setup-produced paths `runCleanWorktreeCheck` names in a check
// note / limitation before collapsing the rest into a "and N more" tail.
const MAX_NOTED_SETUP_PATHS = 10;

// A `git status --porcelain` snapshot of `repoPath`, taken by
// `snapshotWorktreeState` BEFORE `--setup` runs (see runner.ts). Threaded
// into `runGitStateChecks`/`runCleanWorktreeCheck` so the clean-worktree
// check can tell dirt that predates `--setup` (still a blocker) apart from
// output `--setup` itself just produced (never a blocker; see task
// b16ab5d8). `paths: null` means the snapshot attempt itself failed (a git
// error) -- distinct from "snapshot succeeded, worktree was clean" (an
// empty Set) -- so the check can fall back to today's undifferentiated
// behaviour and say so, instead of silently treating a failed snapshot as
// "everything is pre-existing" or "everything is setup output".
export interface WorktreeSnapshot {
  paths: Set<string> | null;
}

/**
 * Snapshots `repoPath`'s `git status --porcelain` output before `--setup`
 * runs. Returns `{ paths: null }` on any git error (never throws) so a
 * caller can still proceed and flag the snapshot as unavailable rather than
 * aborting the run.
 */
export async function snapshotWorktreeState(repoPath: string): Promise<WorktreeSnapshot> {
  try {
    const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: repoPath });
    return { paths: new Set(parsePorcelainEntries(stdout).flatMap((entry) => entry.paths)) };
  } catch {
    return { paths: null };
  }
}

interface PorcelainEntry {
  raw: string;
  // Usually one path; two for a rename/copy line ("R  old -> new"), since
  // either side counts as "the same pre-existing thing" for snapshot
  // membership purposes.
  paths: string[];
}

function parsePorcelainEntries(stdout: string): PorcelainEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      // Porcelain v1: 2-char XY status + 1 space + path (or "old -> new"
      // for a rename/copy).
      const rest = line.slice(3);
      if (rest.includes(" -> ")) {
        const [oldPath, newPath] = rest.split(" -> ");
        return { raw: line, paths: [oldPath.trim(), newPath.trim()] };
      }
      return { raw: line, paths: [rest.trim()] };
    });
}

export async function runGitStateChecks(
  repoPath: string,
  config: PreflightConfig,
  preSetupSnapshot?: WorktreeSnapshot
): Promise<CheckSetResult> {
  const repoReady = await verifyGitRepository(repoPath);
  if (repoReady.limitation) {
    return { checks: [], limitations: [repoReady.limitation] };
  }

  const protectedBranches = config.protectedBranches?.length
    ? config.protectedBranches
    : DEFAULT_PROTECTED_BRANCHES;

  const [branchCheck, worktreeResult] = await Promise.all([
    runProtectedBranchCheck(repoPath, protectedBranches),
    runCleanWorktreeCheck(repoPath, preSetupSnapshot),
  ]);

  return {
    checks: [branchCheck, worktreeResult.check],
    limitations: worktreeResult.limitation ? [worktreeResult.limitation] : [],
  };
}

async function verifyGitRepository(repoPath: string): Promise<{ limitation?: string }> {
  try {
    const { stdout } = await execa(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repoPath }
    );

    if (stdout.trim() !== "true") {
      return { limitation: "Not a git repository; git state checks skipped" };
    }

    return {};
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string; shortMessage?: string };
    const stderr = `${error.stderr ?? ""} ${error.shortMessage ?? ""}`.trim();

    if (error.code === "ENOENT") {
      return { limitation: "git not available; git state checks skipped" };
    }

    if (stderr.includes("dubious ownership")) {
      return { limitation: "git refused repository ownership; git state checks skipped" };
    }

    return { limitation: "Not a git repository; git state checks skipped" };
  }
}

async function runProtectedBranchCheck(
  repoPath: string,
  protectedBranches: string[]
): Promise<CheckResult> {
  const start = Date.now();

  try {
    const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
    });
    const branch = stdout.trim();
    const onProtectedBranch = protectedBranches.includes(branch);

    return {
      name: "protected-branch",
      kind: "git-state",
      status: onProtectedBranch ? "warn" : "pass",
      message: onProtectedBranch
        ? `Repository is on protected branch "${branch}"`
        : undefined,
      details: onProtectedBranch
        ? ["Create a feature branch before pushing if this repository uses a PR workflow"]
        : [`On branch: ${branch}`],
      durationMs: Date.now() - start,
      confidenceContribution: 0.05,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      name: "protected-branch",
      kind: "git-state",
      status: "warn",
      message: `Failed to inspect current branch: ${error.message}`,
      durationMs: Date.now() - start,
      confidenceContribution: 0.05,
    };
  }
}

function buildCleanWorktreeResult(hasChanges: boolean, start: number): CheckResult {
  return {
    name: "clean-worktree",
    kind: "git-state",
    status: hasChanges ? "fail" : "pass",
    message: hasChanges ? "Repository has uncommitted changes" : undefined,
    details: hasChanges
      ? ["Commit or stash changes before relying on preflight results for a push"]
      : undefined,
    durationMs: Date.now() - start,
    confidenceContribution: 0.05,
  };
}

async function runCleanWorktreeCheck(
  repoPath: string,
  preSetupSnapshot?: WorktreeSnapshot
): Promise<{ check: CheckResult; limitation?: string }> {
  const start = Date.now();

  try {
    const { stdout } = await execa("git", ["status", "--porcelain"], {
      cwd: repoPath,
    });

    // No `--setup` run (or the caller didn't pass a snapshot at all): the
    // exact same code path as before this feature existed, so behaviour
    // stays byte-identical without `--setup` (tracker criterion 3).
    if (!preSetupSnapshot) {
      return { check: buildCleanWorktreeResult(stdout.trim().length > 0, start) };
    }

    // The snapshot attempt itself failed (a git error before `--setup`
    // ran): fall back to today's undifferentiated behaviour rather than
    // guessing, and say so via a limitation so this isn't a silent pass.
    if (preSetupSnapshot.paths === null) {
      return {
        check: buildCleanWorktreeResult(stdout.trim().length > 0, start),
        limitation:
          "Could not snapshot the worktree before --setup ran (git status failed); " +
          "clean-worktree fell back to checking the full worktree diff and cannot " +
          "distinguish pre-existing changes from --setup output this run",
      };
    }

    const currentEntries = parsePorcelainEntries(stdout);
    const snapshotPaths = preSetupSnapshot.paths;
    const preExisting = currentEntries.filter((entry) => entry.paths.some((p) => snapshotPaths.has(p)));
    const setupProduced = currentEntries.filter((entry) => !entry.paths.some((p) => snapshotPaths.has(p)));

    // Any change that predates `--setup` still blocks, exactly as today,
    // regardless of whether `--setup` also produced its own output.
    if (preExisting.length > 0) {
      return { check: buildCleanWorktreeResult(true, start) };
    }

    if (setupProduced.length > 0) {
      const names = setupProduced.map((entry) => entry.paths[entry.paths.length - 1]);
      const capped = names.slice(0, MAX_NOTED_SETUP_PATHS);
      const remainder = names.length - capped.length;
      const list = capped.join(", ") + (remainder > 0 ? `, and ${remainder} more` : "");

      return {
        check: {
          name: "clean-worktree",
          kind: "git-state",
          status: "pass",
          message: "--setup left untracked or modified files that are not gitignored",
          details: [
            `Setup-produced paths: ${list}`,
            "Add them to .gitignore so a future clean-worktree check reflects only real repository changes",
          ],
          durationMs: Date.now() - start,
          confidenceContribution: 0.05,
        },
        limitation: `--setup left untracked or modified files that are not gitignored (${list}); add them to .gitignore`,
      };
    }

    return { check: buildCleanWorktreeResult(false, start) };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      check: {
        name: "clean-worktree",
        kind: "git-state",
        status: "warn",
        message: `Failed to inspect worktree state: ${error.message}`,
        durationMs: Date.now() - start,
        confidenceContribution: 0.05,
      },
    };
  }
}
