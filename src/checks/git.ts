import { execa } from "execa";
import { CheckResult, PreflightConfig } from "../types.js";
import { CheckSetResult } from "./shared.js";

const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

export async function runGitStateChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const repoReady = await verifyGitRepository(repoPath);
  if (repoReady.limitation) {
    return { checks: [], limitations: [repoReady.limitation] };
  }

  const protectedBranches = config.protectedBranches?.length
    ? config.protectedBranches
    : DEFAULT_PROTECTED_BRANCHES;

  const [branchCheck, worktreeCheck] = await Promise.all([
    runProtectedBranchCheck(repoPath, protectedBranches),
    runCleanWorktreeCheck(repoPath),
  ]);

  return {
    checks: [branchCheck, worktreeCheck],
    limitations: [],
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

async function runCleanWorktreeCheck(repoPath: string): Promise<CheckResult> {
  const start = Date.now();

  try {
    const { stdout } = await execa("git", ["status", "--porcelain"], {
      cwd: repoPath,
    });
    const hasChanges = stdout.trim().length > 0;

    return {
      name: "clean-worktree",
      kind: "git-state",
      status: hasChanges ? "fail" : "pass",
      message: hasChanges
        ? "Repository has uncommitted changes"
        : undefined,
      details: hasChanges
        ? ["Commit or stash changes before relying on preflight results for a push"]
        : undefined,
      durationMs: Date.now() - start,
      confidenceContribution: 0.05,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      name: "clean-worktree",
      kind: "git-state",
      status: "warn",
      message: `Failed to inspect worktree state: ${error.message}`,
      durationMs: Date.now() - start,
      confidenceContribution: 0.05,
    };
  }
}
