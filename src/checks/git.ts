import { execa } from "execa";
import { CheckResult, PreflightConfig } from "../types.js";
import { CheckSetResult } from "./shared.js";

const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

// How many setup-produced paths `runCleanWorktreeCheck` names in a check
// note / limitation before collapsing the rest into a "and N more" tail.
const MAX_NOTED_SETUP_PATHS = 10;

// A `git status --porcelain -z` snapshot of `repoPath`, taken by
// `snapshotWorktreeState` BEFORE `--setup` runs (see runner.ts). Threaded
// into `runGitStateChecks`/`runCleanWorktreeCheck` so the clean-worktree
// check can tell dirt that predates `--setup` (still a blocker) apart from
// output `--setup` itself just produced (never a blocker for untracked
// output; still a blocker when `--setup` touched a TRACKED file -- see
// task b16ab5d8, review finding F1). `paths: null` means the snapshot
// attempt itself failed (a git error) -- distinct from "snapshot
// succeeded, worktree was clean" (an empty Set) -- so the check can fall
// back to today's undifferentiated behaviour and say so, instead of
// silently treating a failed snapshot as "everything is pre-existing" or
// "everything is setup output".
export interface WorktreeSnapshot {
  paths: Set<string> | null;
}

/**
 * Snapshots `repoPath`'s `git status --porcelain -z` output before
 * `--setup` runs. Returns `{ paths: null }` on any git error (never
 * throws) so a caller can still proceed and flag the snapshot as
 * unavailable rather than aborting the run.
 */
export async function snapshotWorktreeState(repoPath: string): Promise<WorktreeSnapshot> {
  try {
    const { stdout } = await execa("git", ["status", "--porcelain", "-z"], { cwd: repoPath });
    return { paths: new Set(parsePorcelainEntriesZ(stdout).flatMap((entry) => entry.paths)) };
  } catch {
    return { paths: null };
  }
}

interface PorcelainEntry {
  // The 2-char XY status prefix, e.g. "??" (untracked), " M" (modified,
  // unstaged), "R " (renamed, staged), "!!" (ignored -- unreachable via a
  // default `git status --porcelain` call, since that never lists ignored
  // paths without `--ignored`; kept so a caller can still treat it like
  // "??" if that ever changes).
  status: string;
  // One path, or [currentPath, fromPath] for a rename/copy record.
  paths: string[];
}

// Parses `git status --porcelain -z` output: NUL-separated records instead
// of the newline-separated `--porcelain` format's `"XY PATH"` /
// `"XY OLD -> NEW"` text. A repository-controlled filename containing a
// literal newline or a literal " -> " substring can no longer be misread
// as a rename delimiter or truncate an entry (`-z` never quotes and a
// rename record is unambiguous: two NUL-terminated fields instead of one
// field containing " -> ") (task b16ab5d8, review finding F4).
function parsePorcelainEntriesZ(stdout: string): PorcelainEntry[] {
  // `-z` terminates every field with NUL, including the last one, so
  // splitting on "\0" always leaves one trailing empty string; nothing
  // else is ever empty (a status record is always at least "XY ").
  const fields = stdout.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") {
    fields.pop();
  }

  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const record = fields[i];
    const status = record.slice(0, 2);
    const currentPath = record.slice(3);

    // A rename/copy status consumes one extra NUL-terminated field: the
    // "from" path, carrying no status prefix of its own. Checked on
    // either status column since git can report a rename in either
    // position depending on staged vs. worktree comparison.
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      const fromPath = fields[i + 1] ?? "";
      entries.push({ status, paths: [currentPath, fromPath] });
      i += 2;
    } else {
      entries.push({ status, paths: [currentPath] });
      i += 1;
    }
  }
  return entries;
}

// True when `status` (a `-z` record's 2-char XY prefix) marks the entry
// untracked (`??`) or ignored (`!!`) -- the only statuses
// `runCleanWorktreeCheck` excuses as harmless `--setup` output. Any other
// status (` M`, `M `, ` D`, `A `, `R `, `C `, `MM`, ...) means git is
// already tracking the path, so `--setup` having touched it is a real
// content change to a committed file that `.gitignore` cannot wave away
// (task b16ab5d8, review finding F1).
function isUntrackedOrIgnoredStatus(status: string): boolean {
  return status === "??" || status === "!!";
}

// Joins `names` for a check message/limitation, capping the list at
// `MAX_NOTED_SETUP_PATHS` and folding the remainder into a "and N more"
// tail so a repo with dozens of setup-produced paths doesn't blow up the
// message.
function formatNotedPaths(names: string[]): string {
  const capped = names.slice(0, MAX_NOTED_SETUP_PATHS);
  const remainder = names.length - capped.length;
  return capped.join(", ") + (remainder > 0 ? `, and ${remainder} more` : "");
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
    // The plain (non `-z`) call this check has always used, kept
    // byte-identical for the no-snapshot and failed-snapshot fallback
    // paths below (tracker criterion 3; review finding F2) -- neither
    // path needs per-path parsing, only "is the worktree dirty at all".
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

    // A real snapshot exists: re-inspect via `-z` for unambiguous per-path
    // classification (parsePorcelainEntriesZ; review finding F4).
    const { stdout: stdoutZ } = await execa("git", ["status", "--porcelain", "-z"], {
      cwd: repoPath,
    });
    const currentEntries = parsePorcelainEntriesZ(stdoutZ);
    const snapshotPaths = preSetupSnapshot.paths;
    const preExisting = currentEntries.filter((entry) => entry.paths.some((p) => snapshotPaths.has(p)));
    const produced = currentEntries.filter((entry) => !entry.paths.some((p) => snapshotPaths.has(p)));

    // Any change that predates `--setup` still blocks, exactly as today,
    // regardless of whether `--setup` also produced its own output.
    if (preExisting.length > 0) {
      return { check: buildCleanWorktreeResult(true, start) };
    }

    // Among the paths `--setup` produced, only untracked (or ignored)
    // ones are excusable build/install output; anything git already
    // tracks that `--setup` modified or removed (a committed `dist/`
    // file the build rewrote, `package-lock.json` rewritten by `npm ci`)
    // is a real content change to a committed file, not something
    // `.gitignore` can fix, so it still blocks (review finding F1).
    const trackedProduced = produced.filter((entry) => !isUntrackedOrIgnoredStatus(entry.status));
    const untrackedProduced = produced.filter((entry) => isUntrackedOrIgnoredStatus(entry.status));

    if (trackedProduced.length > 0) {
      const names = trackedProduced.map((entry) => entry.paths[0]);
      const list = formatNotedPaths(names);

      return {
        check: {
          name: "clean-worktree",
          kind: "git-state",
          status: "fail",
          message: "--setup modified or removed tracked files",
          details: [
            `Setup-modified tracked paths: ${list}`,
            "Commit the rebuilt artifacts, or stop tracking build output, before relying on this run",
          ],
          durationMs: Date.now() - start,
          confidenceContribution: 0.05,
        },
      };
    }

    if (untrackedProduced.length > 0) {
      const names = untrackedProduced.map((entry) => entry.paths[0]);
      const list = formatNotedPaths(names);

      return {
        check: {
          name: "clean-worktree",
          kind: "git-state",
          status: "pass",
          message: "--setup left untracked files that are not gitignored",
          details: [
            `Setup-produced paths: ${list}`,
            "Add them to .gitignore so a future clean-worktree check reflects only real repository changes",
          ],
          durationMs: Date.now() - start,
          confidenceContribution: 0.05,
        },
        limitation: `--setup left untracked files that are not gitignored (${list}); add them to .gitignore`,
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
