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

const DEFAULT_BRANCHES = ["main", "master"];

/**
 * The base of the changed-file set: the nearest trustworthy merge base of
 * HEAD, or null. Candidates (local refs only, no network):
 * - the base diff-scoped secret detection resolves (`resolveDiffBase`),
 * - `<remote>/HEAD`, `<remote>/main` and `<remote>/master` of every remote,
 * - local `main` and `master`, only when every commit on them is on a remote.
 * The current branch, its upstream and any symbolic ref pointing at either
 * are never candidates. The branch's pushed copies `<remote>/<branch>` hold
 * its own commits: they (and symbolic refs to them) do not count as "on a
 * remote" for local `main`/`master`, and when the secret-detection base is
 * the merge base with the upstream copy it is used only if no other merge
 * base remains. Candidate refs are deduplicated by commit, a merge base equal
 * to HEAD is ignored, and the merge base with the fewest commits up to HEAD
 * wins (the first one on a tie).
 */
async function nearestDiffBase(repoPath: string): Promise<string | null> {
  const head = (await gitLines(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.[0];
  if (head === undefined) return null;
  const current = (await gitLines(repoPath, ["symbolic-ref", "-q", "HEAD"]))?.[0];
  const upstream = (await gitLines(repoPath, ["rev-parse", "--symbolic-full-name", "@{u}"]))?.[0];
  const remotes = (await gitLines(repoPath, ["remote"])) ?? [];
  const branch = current?.replace(/^refs\/heads\//, "");
  const copies = new Set(branch === undefined ? [] : remotes.map((remote) => `refs/remotes/${remote}/${branch}`));
  const own = new Set<string>();
  if (current !== undefined) own.add(current);
  if (upstream !== undefined) own.add(upstream);

  const candidates = remotes.flatMap((remote) =>
    ["HEAD", ...DEFAULT_BRANCHES].map((name) => `refs/remotes/${remote}/${name}`));
  const local = DEFAULT_BRANCHES.map((name) => `refs/heads/${name}`);
  const refs = new Map<string, { target: string; commit: string }>();
  const listed = await gitLines(repoPath, [
    "for-each-ref", "--format=%(refname) %(symref) %(objectname)", ...candidates, ...local,
  ]);
  for (const line of listed ?? []) {
    const [name, symref, commit] = line.split(" ");
    refs.set(name, { target: symref || name, commit });
  }
  // A pushed copy (or a symbolic ref to one) carries this branch's own
  // commits, so it does not vouch for a local main/master.
  const excluded = [...copies, ...candidates.filter((name) => copies.has(refs.get(name)?.target ?? ""))]
    .map((name) => `--exclude=${name.slice("refs/remotes/".length)}`);

  const bases: { mb: string; distance: number }[] = [];
  const consider = async (mb: string | undefined): Promise<void> => {
    if (mb === undefined || mb === head || bases.some((b) => b.mb === mb)) return;
    const count = (await gitLines(repoPath, ["rev-list", "--count", `${mb}..HEAD`]))?.[0];
    bases.push({ mb, distance: count === undefined ? Number.POSITIVE_INFINITY : Number(count) });
  };
  const secretsBase = await resolveDiffBase({ repoPath, env: process.env });
  const fromCopy = upstream !== undefined && copies.has(upstream)
    && secretsBase === (await gitLines(repoPath, ["merge-base", "HEAD", upstream]))?.[0];
  if (secretsBase !== null && !fromCopy) await consider(secretsBase);
  // The base from a pushed copy hides the pushed commits, so it is used only
  // when nothing else remains; it still covers every unpushed commit.
  const lastResort = fromCopy && secretsBase !== head ? secretsBase : null;
  const seen = new Set<string>();
  for (const name of [...candidates, ...local]) {
    const ref = refs.get(name);
    if (ref === undefined || own.has(name) || own.has(ref.target) || seen.has(ref.commit)) continue;
    if (local.includes(name)) {
      const unpushed = (await gitLines(repoPath, ["rev-list", "--count", name, "--not", ...excluded, "--remotes"]))?.[0];
      if (unpushed !== "0") continue;
    }
    seen.add(ref.commit);
    await consider((await gitLines(repoPath, ["merge-base", "HEAD", ref.commit]))?.[0]);
  }

  let best: { mb: string; distance: number } | null = null;
  for (const base of bases) if (best === null || base.distance < best.distance) best = base;
  return best?.mb ?? lastResort;
}

interface ChangedFiles {
  files: string[];
  /** HEAD has a commit but its last-commit diff could not be computed (root commit or shallow boundary). */
  rangeUnknown: boolean;
}

/**
 * Every file the current work changed, relative to the git root: the diff
 * against the nearest trustworthy merge base (see nearestDiffBase), which
 * covers committed and working-tree edits, plus untracked-and-unignored
 * files. Deleted files are excluded. Without such a base the diff falls back
 * to HEAD~1..HEAD plus working-tree changes against HEAD; when HEAD has a
 * commit but no parent in reach (root commit or shallow boundary) that range
 * is reported as unknown.
 */
async function getChangedFiles(repoPath: string): Promise<ChangedFiles> {
  const changed = new Set<string>();
  let rangeUnknown = false;
  const base = await nearestDiffBase(repoPath);
  const tracked = base !== null
    ? await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", base])
    : null;
  if (tracked !== null) {
    tracked.forEach((f) => changed.add(f));
  } else {
    const last = await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", "HEAD~1..HEAD"]);
    if (last === null && (await gitLines(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null) {
      rangeUnknown = true;
    }
    (last ?? []).forEach((f) => changed.add(f));
    const working = await gitLines(repoPath, ["diff", "--name-only", "--diff-filter=d", "HEAD"]);
    (working ?? []).forEach((f) => changed.add(f));
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
