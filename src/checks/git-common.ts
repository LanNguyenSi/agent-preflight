import { execa } from "execa";

/** Where and with which environment every git call of a Git operation executes. */
export interface GitContext {
  repoPath: string;
  env: NodeJS.ProcessEnv;
}

/** Run git in `git.repoPath` with the chosen environment; never rejects on a non-zero exit. */
export function gitExec(
  git: GitContext,
  args: string[],
  options: { input?: string; raw?: boolean } = {},
) {
  return execa("git", args, {
    cwd: git.repoPath,
    env: git.env,
    extendEnv: false,
    reject: false,
    input: options.input,
    ...(options.raw ? { stripFinalNewline: false, maxBuffer: 512 * 1024 * 1024 } : {}),
  });
}

/** Run a git command; return stdout on a clean exit, `null` on any failure. */
export async function runGit(git: GitContext, args: string[]): Promise<string | null> {
  try {
    const res = await gitExec(git, args);
    return res.exitCode === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

interface DiffBaseCandidate {
  ref: string;
  /**
   * Upstream and named remote-tracking candidates use trusted handling;
   * local main/master fallbacks do not. An upstream can also track a
   * purely local branch, and still uses trusted handling in that setup.
   */
  trusted: boolean;
}

/**
 * Resolve the merge-base with the upstream tracking branch, then
 * origin/HEAD, then a common default branch. Return null when no
 * candidate resolves, so callers can handle an unknown base explicitly.
 * Every command uses the caller's chosen GitContext environment.
 *
 * A trusted candidate can return HEAD when the branch has not diverged.
 * Comparing that base against the working tree still includes pending
 * edits. A local main/master fallback whose merge-base equals HEAD is
 * skipped: the branch name alone does not establish a default branch.
 * Upstream candidates remain trusted even when configured to track a
 * purely local branch rather than a remote-tracking branch.
 */
export async function resolveDiffBase(git: GitContext): Promise<string | null> {
  const headSha = (await runGit(git, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const candidates: DiffBaseCandidate[] = [];
  const upstream = await runGit(git, [
    "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
  ]);
  if (upstream) candidates.push({ ref: upstream.trim(), trusted: true });
  const originHead = await runGit(git, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead) candidates.push({ ref: originHead.trim(), trusted: true });
  candidates.push(
    { ref: "origin/main", trusted: true },
    { ref: "origin/master", trusted: true },
    { ref: "main", trusted: false },
    { ref: "master", trusted: false },
  );

  for (const { ref, trusted } of candidates) {
    if (!ref) continue;
    const mb = (await runGit(git, ["merge-base", "HEAD", ref]))?.trim();
    if (!mb) continue;
    if (headSha !== null && mb === headSha && !trusted) continue; // unconfirmed guess: not real divergence signal
    return mb;
  }
  return null;
}

