import fs from "fs";
import path from "path";
import { CheckResult, PreflightConfig } from "../types.js";
import { CheckSetResult } from "./shared.js";

const DEFAULT_EXCEPTIONS = ["index.ts", "index.js", "types.ts", "types.js", "constants.ts", "constants.js"];

const SOURCE_EXT = /\.(ts|js)$/;
const TEST_PATTERN = /\.(test|spec)\.(ts|js)$/;
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/** Find changed source files via git diff */
async function getChangedSourceFiles(repoPath: string): Promise<string[]> {
  const { execa } = await import("execa");

  // Try diff against HEAD~1, fall back to all tracked files
  const { stdout, exitCode } = await execa(
    "git", ["diff", "--name-only", "HEAD~1..HEAD"],
    { cwd: repoPath, reject: false },
  );

  const files = exitCode === 0
    ? stdout.trim().split("\n").filter(Boolean)
    : [];

  return files
    .filter((f) => SOURCE_EXT.test(f))
    .filter((f) => !TEST_PATTERN.test(f));
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
  const changedFiles = gitRoot
    ? (await getChangedSourceFiles(gitRoot))
      .map((file) => toTargetRelativePath(gitRoot, targetPath, file))
      .filter((file): file is string => file !== null)
    : [];
  const exceptions = new Set(config.tddExceptions ?? DEFAULT_EXCEPTIONS);

  // Filter out exceptions
  const filesToCheck = changedFiles.filter(
    (f) => !exceptions.has(path.basename(f)),
  );

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
