import fs from "fs";
import path from "path";
import { CheckResult, PreflightConfig } from "../types.js";
import { CheckSetResult } from "./shared.js";
import { resolveDiffBase } from "./secrets.js";

const DEFAULT_EXCEPTIONS = ["index.ts", "index.js", "types.ts", "types.js", "constants.ts", "constants.js"];

const SOURCE_EXT = /\.(ts|js)$/;
const TEST_PATTERN = /\.(test|spec)\.(ts|js)$/;
/** Source files of other types (other languages, or JS/TS variants) that this check cannot pair with tests. */
const OTHER_SOURCE_EXT = /\.(tsx|jsx|mts|cts|mjs|cjs|php|py|rb|go|rs|java|kt|kts|scala|cs|c|cc|cpp|h|hpp|swift|vue|svelte|sh)$/;
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/** Run git and return the non-empty output lines, or null on failure. */
async function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
  const { execa } = await import("execa");
  const { stdout, exitCode } = await execa(
    "git", ["-c", "core.quotePath=false", ...args],
    { cwd, reject: false },
  );
  if (exitCode !== 0) return null;
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Nearest merge base of HEAD with a default branch, or null. Candidates are
 * the local refs `<remote>/HEAD`, `<remote>/main` and `<remote>/master` of
 * every remote plus local `main` and `master` (no network). The current
 * branch, its upstream and any symbolic ref pointing at either are skipped,
 * and so is a candidate whose merge base is HEAD itself, since it carries no
 * information. Of the rest, the merge base with the fewest commits up to
 * HEAD wins, so a stale fork or a leftover `master` loses to a nearer base. A
 * pushed branch has its upstream at HEAD, so this keeps the earlier commits
 * of the branch visible.
 */
async function defaultBranchMergeBase(repoPath: string): Promise<string | null> {
  const head = (await gitLines(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.[0];
  const own = new Set<string>();
  const current = (await gitLines(repoPath, ["symbolic-ref", "-q", "HEAD"]))?.[0];
  if (current !== undefined) own.add(current);
  const upstream = (await gitLines(repoPath, ["rev-parse", "--symbolic-full-name", "@{u}"]))?.[0];
  if (upstream !== undefined) own.add(upstream);

  const candidates: string[] = [];
  for (const remote of (await gitLines(repoPath, ["remote"])) ?? []) {
    for (const name of ["HEAD", "main", "master"]) candidates.push(`refs/remotes/${remote}/${name}`);
  }
  candidates.push("refs/heads/main", "refs/heads/master");
  const existing = new Map<string, string>();
  for (const line of (await gitLines(repoPath, ["for-each-ref", "--format=%(refname) %(symref)", ...candidates])) ?? []) {
    const [name, symref] = line.split(" ");
    existing.set(name, symref || name);
  }

  let best: { mb: string; distance: number } | null = null;
  for (const ref of candidates) {
    const target = existing.get(ref);
    if (target === undefined || own.has(ref) || own.has(target)) continue;
    const mb = (await gitLines(repoPath, ["merge-base", "HEAD", ref]))?.[0];
    if (mb === undefined || mb === head) continue;
    const count = (await gitLines(repoPath, ["rev-list", "--count", `${mb}..HEAD`]))?.[0];
    const distance = count === undefined ? Number.POSITIVE_INFINITY : Number(count);
    if (distance < (best?.distance ?? Number.POSITIVE_INFINITY)) best = { mb, distance };
  }
  return best?.mb ?? null;
}

interface ChangedFiles {
  files: string[];
  /** HEAD has a commit but its last-commit diff could not be computed (root commit or shallow boundary). */
  rangeUnknown: boolean;
}

/**
 * Every file the current work changed, relative to the git root: the branch
 * diff against the merge-base (same base resolution as diff-scoped secret
 * detection) including working-tree edits, unioned with the diff against the
 * nearest default-branch merge-base, plus untracked-and-unignored files. Deleted
 * files are excluded. Without a resolvable base the diff falls back to
 * HEAD~1..HEAD plus working-tree changes against HEAD.
 */
async function getChangedFiles(repoPath: string): Promise<ChangedFiles> {
  const changed = new Set<string>();
  let rangeUnknown = false;
  const lastCommit = async (): Promise<string[]> => {
    const last = await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", "HEAD~1..HEAD"]);
    if (last === null && (await gitLines(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null) {
      rangeUnknown = true;
    }
    return last ?? [];
  };
  const base = await resolveDiffBase(repoPath);
  const tracked = base !== null
    ? await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", base])
    : null;
  if (tracked !== null) {
    tracked.forEach((f) => changed.add(f));
    // A base equal to HEAD means no divergence (HEAD equals its upstream or
    // sits on the default branch): the branch diff is empty, so keep the last
    // commit as a floor. It adds nothing when HEAD has no parent (root
    // commit or shallow clone).
    const head = (await gitLines(repoPath, ["rev-parse", "HEAD"]))?.[0];
    if (head !== undefined && head === base) (await lastCommit()).forEach((f) => changed.add(f));
  } else {
    (await lastCommit()).forEach((f) => changed.add(f));
    const working = await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", "HEAD"]);
    (working ?? []).forEach((f) => changed.add(f));
  }
  const defaultBase = await defaultBranchMergeBase(repoPath);
  if (defaultBase !== null) {
    const branch = await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", defaultBase]);
    (branch ?? []).forEach((f) => changed.add(f));
  }
  const untracked = await gitLines(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  (untracked ?? []).forEach((f) => changed.add(f));
  return { files: [...changed], rangeUnknown };
}

/** Return git's real worktree root so linked worktrees and path aliases agree. */
async function getGitRoot(repoPath: string): Promise<string | null> {
  const { execa } = await import("execa");
  const { stdout, exitCode } = await execa(
    "git", ["rev-parse", "--show-toplevel"],
    { cwd: repoPath, reject: false },
  );
  if (exitCode !== 0 || !stdout.trim()) return null;
  try { return fs.realpathSync(stdout.trim()); } catch { return null; }
}

/** Rebase a git-root-relative path into target coordinates, rejecting siblings. */
function toTargetRelativePath(gitRoot: string, targetPath: string, file: string): string | null {
  const relative = path.relative(targetPath, path.join(gitRoot, file));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

/** Collect all test files in the repo */
function collectTestFiles(repoPath: string): Set<string> {
  const testFiles = new Set<string>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else if (TEST_PATTERN.test(entry.name)) {
        testFiles.add(path.relative(repoPath, full));
      }
    }
  }

  walk(repoPath);
  return testFiles;
}

/** Check if a source file has a matching test file */
function hasTestCounterpart(sourceFile: string, testFiles: Set<string>): boolean {
  const dir = path.dirname(sourceFile);
  const base = path.basename(sourceFile).replace(SOURCE_EXT, "");
  const ext = path.extname(sourceFile).slice(1);

  // Check common patterns:
  // src/foo.ts → src/foo.test.ts, src/foo.spec.ts
  // src/foo.ts → src/__tests__/foo.test.ts, src/__tests__/foo.spec.ts
  // src/foo.ts → tests/foo.test.ts
  const candidates = [
    path.join(dir, `${base}.test.${ext}`),
    path.join(dir, `${base}.spec.${ext}`),
    path.join(dir, "__tests__", `${base}.test.${ext}`),
    path.join(dir, "__tests__", `${base}.spec.${ext}`),
  ];

  // Also check tests/ at repo root
  const parts = sourceFile.split(path.sep);
  if (parts[0] === "src") {
    const rest = parts.slice(1);
    rest[rest.length - 1] = `${base}.test.${ext}`;
    candidates.push(path.join("tests", ...rest));
    rest[rest.length - 1] = `${base}.spec.${ext}`;
    candidates.push(path.join("tests", ...rest));
  }

  return candidates.some((c) => testFiles.has(c));
}

export async function runTddCheck(
  repoPath: string,
  config: PreflightConfig,
): Promise<CheckSetResult> {
  const checks: CheckResult[] = [];
  const limitations: string[] = [];
  const start = Date.now();

  // Use physical paths for both sides: git reports root-relative names while
  // the directory walk reports paths relative to the evaluated target.
  let targetPath: string;
  try { targetPath = fs.realpathSync(repoPath); } catch { targetPath = repoPath; }
  const gitRoot = await getGitRoot(targetPath);
  const found = gitRoot ? await getChangedFiles(gitRoot) : { files: [], rangeUnknown: false };
  const allChanged = gitRoot
    ? found.files
      .map((file) => toTargetRelativePath(gitRoot, targetPath, file))
      .filter((file): file is string => file !== null)
    : [];
  const changedFiles = allChanged
    .filter((f) => SOURCE_EXT.test(f))
    .filter((f) => !TEST_PATTERN.test(f));
  const exceptions = new Set(config.tddExceptions ?? DEFAULT_EXCEPTIONS);

  // Filter out exceptions
  const filesToCheck = changedFiles.filter(
    (f) => !exceptions.has(path.basename(f)),
  );

  // The last commit could not be examined (root commit or shallow boundary):
  // the found set may miss committed changes, so say so whatever else was
  // found, and with nothing found an empty set is not evidence of "no
  // changes".
  if (found.rangeUnknown) {
    limitations.push(
      "tdd-test-counterpart: diff range could not be determined (shallow clone or root commit); committed changes may not have been checked",
    );
    if (allChanged.length === 0) {
      checks.push({
        name: "tdd-test-counterpart",
        kind: "tdd",
        status: "skip",
        message: "Diff range could not be determined (shallow clone or root commit); test counterparts were not checked",
        durationMs: Date.now() - start,
        confidenceContribution: 0.05,
      });
      return { checks, limitations };
    }
  }

  // Changed files exist but none is a .ts/.js file: the check cannot judge
  // them, so it must not report a pass that raises confidence.
  if (allChanged.length > 0 && !allChanged.some((f) => SOURCE_EXT.test(f))) {
    const others = allChanged.length;
    checks.push({
      name: "tdd-test-counterpart",
      kind: "tdd",
      status: "skip",
      message: `No .ts/.js source changed (${others} other file(s) not checked); test counterparts were not checked`,
      durationMs: Date.now() - start,
      confidenceContribution: 0.05,
    });
    limitations.push(
      `tdd-test-counterpart only checks .ts/.js sources; other file types not checked (${others} changed file(s))`,
    );
    return { checks, limitations };
  }

  // Checked .ts/.js files alongside source files of other types (other
  // languages, or .tsx/.jsx/.mts/.cts/.mjs/.cjs): the verdict below covers
  // only the .ts/.js files.
  const unchecked = allChanged.filter((f) => OTHER_SOURCE_EXT.test(f));
  if (unchecked.length > 0) {
    limitations.push(
      `tdd-test-counterpart only checks .ts/.js sources; other file types not checked (${unchecked.length} changed source file(s))`,
    );
  }

  if (filesToCheck.length === 0) {
    checks.push({
      name: "tdd-test-counterpart",
      kind: "tdd",
      status: "pass",
      message: "No checkable source files changed",
      durationMs: Date.now() - start,
      confidenceContribution: 0.05,
    });
    return { checks, limitations };
  }

  const testFiles = collectTestFiles(targetPath);
  const missing = filesToCheck.filter((f) => !hasTestCounterpart(f, testFiles));

  checks.push({
    name: "tdd-test-counterpart",
    kind: "tdd",
    status: missing.length > 0 ? "warn" : "pass",
    message: missing.length > 0
      ? `${missing.length} changed source file(s) have no test counterpart`
      : "All changed source files have test counterparts",
    details: missing.length > 0 ? missing : undefined,
    durationMs: Date.now() - start,
    confidenceContribution: 0.1,
  });

  return { checks, limitations };
}
