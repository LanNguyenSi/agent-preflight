import { execa } from "execa";
import fs from "fs";
import os from "os";
import path from "path";
import { CheckResult, CheckKind, PreflightConfig } from "../types.js";

export interface CheckSetResult {
  checks: CheckResult[];
  limitations: string[];
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ComposerJson {
  scripts?: Record<string, unknown>;
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
}

export interface ProjectContext {
  repoPath: string;
  packageJson?: PackageJson;
  composerJson?: ComposerJson;
  suggestedWorkingDir?: string;
  hasPyproject: boolean;
  hasSetupPy: boolean;
  hasRequirementsTxt: boolean;
  hasTsconfig: boolean;
  hasPomXml: boolean;
  hasMavenWrapper: boolean;
  hasGradleBuild: boolean;
  hasGradleWrapper: boolean;
}

export function createProjectContext(repoPath: string): ProjectContext {
  const packageJson = readJsonFile<PackageJson>(path.join(repoPath, "package.json"));

  return {
    repoPath,
    packageJson,
    composerJson: readJsonFile<ComposerJson>(path.join(repoPath, "composer.json")),
    suggestedWorkingDir: packageJson ? undefined : findSuggestedWorkingDir(repoPath, "package.json"),
    hasPyproject: fs.existsSync(path.join(repoPath, "pyproject.toml")),
    hasSetupPy: fs.existsSync(path.join(repoPath, "setup.py")),
    hasRequirementsTxt: fs.existsSync(path.join(repoPath, "requirements.txt")),
    hasTsconfig: fs.existsSync(path.join(repoPath, "tsconfig.json")),
    hasPomXml: fs.existsSync(path.join(repoPath, "pom.xml")),
    hasMavenWrapper: fs.existsSync(path.join(repoPath, "mvnw")),
    hasGradleBuild:
      fs.existsSync(path.join(repoPath, "build.gradle")) ||
      fs.existsSync(path.join(repoPath, "build.gradle.kts")),
    hasGradleWrapper: fs.existsSync(path.join(repoPath, "gradlew")),
  };
}

export function hasNodeProject(context: ProjectContext): boolean {
  return context.packageJson !== undefined;
}

export function hasPythonProject(context: ProjectContext): boolean {
  return context.hasPyproject || context.hasSetupPy || context.hasRequirementsTxt;
}

export function hasPhpProject(context: ProjectContext): boolean {
  return context.composerJson !== undefined;
}

export function hasJavaProject(context: ProjectContext): boolean {
  return context.hasPomXml || context.hasMavenWrapper || context.hasGradleBuild || context.hasGradleWrapper;
}

export function hasNodeDependency(context: ProjectContext, name: string): boolean {
  return Boolean(
    context.packageJson?.dependencies?.[name] ||
    context.packageJson?.devDependencies?.[name]
  );
}

export function hasComposerScript(context: ProjectContext, name: string): boolean {
  const script = context.composerJson?.scripts?.[name];
  return Array.isArray(script) || typeof script === "string";
}

export function hasComposerPackage(context: ProjectContext, name: string): boolean {
  return Boolean(
    context.composerJson?.require?.[name] ||
    context.composerJson?.["require-dev"]?.[name]
  );
}

export function getConfiguredCommands(
  config: PreflightConfig,
  kind: "lint" | "typecheck" | "test" | "audit"
): string[] {
  return config.commands?.[kind] ?? [];
}

export async function runConfiguredCommands(
  repoPath: string,
  kind: CheckKind,
  commands: string[],
  weight: number,
  logDir?: string
): Promise<CheckSetResult> {
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  for (const [index, command] of commands.entries()) {
    const result = await runShellCheck({
      repoPath,
      name: `${kind}:${index + 1}`,
      kind,
      command,
      weight,
      failureMessage: `${kind} command failed`,
      timeoutMs: kind === "test" ? 300_000 : undefined,
      logDir,
    });

    if (result.check) {
      checks.push(result.check);
    }
    if (result.limitation) {
      limitations.push(result.limitation);
    }
  }

  return { checks, limitations };
}

interface ShellCheckOptions {
  repoPath: string;
  name: string;
  kind: CheckKind;
  command: string;
  weight: number;
  failureMessage: string;
  failureStatus?: "fail" | "warn";
  timeoutMs?: number;
  missingLimitation?: string;
  // When `command` is a thin wrapper that invokes another tool inside
  // (e.g. `npm run lint` -> `eslint src/`, `composer run test` -> `phpunit`),
  // the primary-binary pre-check sees the wrapper as installed and the run
  // proceeds. If the inner tool is missing, the wrapper still exits non-zero
  // but the cause is "the inner tool isn't installed", not "the code has
  // violations". Setting this flag enables a post-hoc check on stdout/stderr
  // for the specific patterns that indicate the inner tool was the problem
  // (sh "command not found" / "Permission denied", npm "code 127" / "ENOENT"),
  // and reclassifies the check as a `limitation` instead of a `fail`.
  // Reserved for wrapper invocations; do NOT set on direct binary calls,
  // because a legitimate non-zero exit could carry a misleading string.
  treatToolNotFoundAsLimitation?: boolean;
  // Directory the full stdout+stderr of a failing check is persisted to
  // (see `computeFailureDetails`). Defaults to `~/.agent-preflight/logs`
  // when omitted. Tests MUST override this to a temp directory so they
  // never write into the real home directory.
  logDir?: string;
}

interface ShellCheckRunResult {
  check?: CheckResult;
  limitation?: string;
  // Full stdout+stderr of the command, when it actually ran (not set on the
  // early missingLimitation short-circuit, since the command never
  // executed). Not persisted on `CheckResult` itself -- it exists so a
  // caller can run its own post-hoc classification on a `fail` result (see
  // `classifyBuildRequiredFailure` and its use in checks/test.ts) without
  // `runShellCheck` needing to know about that classification itself.
  rawOutput?: string;
}

// Invariant: when `missingLimitation` is set, we first check that the primary
// binary of the command is resolvable. Only then do we execute. This keeps the
// limitation path reserved for "the tool really isn't installed" and prevents
// misclassifying an exit-127 that bubbled up from a nested wrapper script
// (e.g. `npm run lint` where a workspace's eslint binary is non-executable)
// as "npm not installed". Without the pre-check, any 127 would silently be
// swallowed into `limitations[]` and `ready:true` would be returned even
// though the check actually failed.
//
// Caveats:
// - The primary is extracted as the first whitespace-separated token. Callers
//   MUST NOT use env-variable prefixes (`FOO=bar cmd`) or shell indirection
//   (`bash -c "..."`) in `command`; the pre-check would look up the wrong
//   token.
// - `command -v` treats tokens containing `/` (e.g. `./mvnw`,
//   `vendor/bin/phpstan`) as filename tests rather than PATH lookups, so
//   relative paths are resolved against `repoPath` (the execa cwd).
export async function runShellCheck(options: ShellCheckOptions): Promise<ShellCheckRunResult> {
  const start = Date.now();
  const env = buildCommandEnv(options.repoPath);

  if (options.missingLimitation) {
    const primary = options.command.trim().split(/\s+/)[0];
    if (primary && !(await commandExists(primary, options.repoPath))) {
      return { limitation: options.missingLimitation };
    }
  }

  try {
    const { exitCode, all } = await execa(
      "bash",
      ["-c", options.command],
      {
        cwd: options.repoPath,
        reject: false,
        all: true,
        timeout: options.timeoutMs ?? 120_000,
        env,
      }
    );

    if (
      exitCode !== 0 &&
      options.treatToolNotFoundAsLimitation &&
      options.missingLimitation &&
      looksLikeMissingTool(all)
    ) {
      return { limitation: options.missingLimitation };
    }

    return {
      check: {
        name: options.name,
        kind: options.kind,
        status: exitCode === 0 ? "pass" : options.failureStatus ?? "fail",
        message: exitCode === 0 ? undefined : options.failureMessage,
        details: exitCode === 0 ? undefined : computeFailureDetails(options.logDir, options.name, all),
        durationMs: Date.now() - start,
        confidenceContribution: options.weight,
      },
      rawOutput: all,
    };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { all?: string };
    if (error.code === "ENOENT" && options.missingLimitation) {
      return {
        limitation: options.missingLimitation,
      };
    }

    return {
      check: {
        name: options.name,
        kind: options.kind,
        status: options.failureStatus ?? "fail",
        message: `${options.failureMessage}: ${error.message}`,
        details: computeFailureDetails(options.logDir, options.name, error.all),
        durationMs: Date.now() - start,
        confidenceContribution: options.weight,
      },
      rawOutput: error.all,
    };
  }
}

// Evidence patterns for `classifyBuildRequiredFailure` below: a test-check
// failure is only ever reclassified from `fail` to `skip` when the
// captured output NAMES a missing build artifact, never on a generic
// non-zero exit. Kept narrow on purpose -- see the function's own comment
// for the conservatism rationale and README's "Build-required test
// classification" section for the documented limits.
//
// - Node's own `Cannot find module '<path>'` when `<path>` runs through a
//   `dist/` (or `\dist\` on Windows) segment: the most common real-world
//   shape (a workspace's test requiring its own package's build output).
// - `ENOENT ... open '<path>'` naming a `dist/` path: a direct `fs` read of
//   a build artifact that was never produced. Restricted to module
//   resolution failures (see `isEnoentModuleResolutionFailure` below): a
//   plain `fs` read of an unrelated data file living under `dist/` (a
//   cache JSON, a fixture) is not "build required" just because it also
//   sits under a `dist/` path.
// - A workspace's own assertion/thrown message that explicitly states the
//   precondition ("dist/... is missing ... run `npm run build`"): covers a
//   project that guards its own dist-dependent test with a clearer message
//   than a bare module-resolution error. Bounded to a single line and
//   requires BOTH a `dist/` mention and an explicit `npm run build`
//   mention so an unrelated failure that happens to say "missing" or
//   "not found" is never enough by itself.
//
// Both path-bearing patterns capture the quoted path so `isCredibleBuildArtifactPath`
// below can reject a path a build could never fix: one resolved through
// `node_modules` (a third-party dependency's own missing file, not this
// repo's), a bare module specifier with no repo-relative or absolute shape
// (ordinary `node_modules` resolution, e.g. `Cannot find module 'lodash'`),
// an absolute path outside the repo root (when the caller can tell), or a
// path whose `dist/` directory already exists on disk (the workspace HAS
// been built; a missing file inside an already-built `dist/` is a
// different bug, not a missing build).
const DIST_MODULE_NOT_FOUND_PATTERN = /Cannot find module ['"]([^'"]*[\\/]dist[\\/][^'"]*)['"]/i;
const DIST_ENOENT_PATTERN = /ENOENT[^\n]*?open ['"]([^'"]*[\\/]dist[\\/][^'"]*)['"]/i;
const DIST_PRECONDITION_PATTERN = /\bdist[\\/][^\n]{0,120}\b(?:is|was|are)?\s*(?:missing|not found|does not exist)\b[^\n]{0,120}\bnpm run build\b/i;

// A line is only trusted as Node/npm's OWN error output -- never a runner
// code frame echoing surrounding source (`125|     const output = "Error:
// Cannot find module ...";`) and never a test assertion's quoted
// expectation string (`const output = "Error: ..."`, `expect(x).toBe("Error:
// ...")`) -- when it actually STARTS with one of the shapes Node/npm emit
// for a real module-resolution failure. A code-frame or quoted-string line
// never starts this way (it starts with a line number, `const`, `expect(`,
// or similar), so this one check covers both.
const TRUSTED_FAILURE_LINE_PATTERN = /^(Error(?:\s*\[[^\]]*\])?:|Cannot find module\b|ENOENT\b|throw\b|at\s|Require stack:|-\s|npm\s+error\b|npm\s+ERR!)/i;

// An ENOENT naming a `dist/` path is only "build required" evidence when
// it is actually a module-resolution failure, not a generic `fs` read of
// some other file that happens to live under `dist/` (a cache JSON, a
// fixture the test itself writes there): the entry-point extension must
// look like a require/import target, AND the surrounding output must carry
// one of Node's own module-resolution markers.
const ENTRY_POINT_EXTENSION_PATTERN = /\.(?:js|mjs|cjs|d\.ts|json)$/i;
function isEnoentModuleResolutionFailure(candidatePath: string, fullOutput: string): boolean {
  if (!ENTRY_POINT_EXTENSION_PATTERN.test(candidatePath)) return false;
  return /Require stack:|ERR_MODULE_NOT_FOUND/.test(fullOutput);
}

// Walks `absPath`'s segments back to (and including) a `dist` segment and
// returns that directory, e.g. `/repo/packages/x/dist/helpr.js` ->
// `/repo/packages/x/dist`. Returns undefined when no `dist` segment is
// present (should not happen -- callers only reach this after the `dist/`
// patterns above already matched -- but stays defensive).
function distDirFromArtifactPath(absPath: string): string | undefined {
  const parts = absPath.split(path.sep);
  const idx = parts.lastIndexOf("dist");
  if (idx === -1) return undefined;
  const dir = parts.slice(0, idx + 1).join(path.sep);
  return dir.length > 0 ? dir : path.sep;
}

// Rejects a matched path that a build could never fix, per the file-level
// comment on the two DIST_*_PATTERN constants above. `repoPath`, when
// given, enables the two filesystem-dependent checks (absolute-path
// containment, "dist/ already built"); without it (existing unit-test call
// sites that predate this parameter) those two are skipped and only the
// text-only checks (`node_modules`, bare specifier) apply, preserving prior
// behavior for callers that never had a repo to check against.
function isCredibleBuildArtifactPath(rawPath: string, repoPath: string | undefined): boolean {
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.includes("node_modules/") || normalized.startsWith("node_modules/")) {
    return false;
  }

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    // Repo/workspace-relative. The path is relative to a workspace's own
    // cwd, which this function does not know (only `repoPath`, the
    // monorepo root, is available) -- so the "already built" filesystem
    // check below is intentionally skipped for this shape; a relative
    // path is accepted on its (already node_modules-free) text shape alone.
    return true;
  }

  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!isAbsolute) {
    // A bare module specifier (`some-lib/dist/index.js`): resolved via
    // node_modules lookup, not a path into this repo -- a build here would
    // not produce it.
    return false;
  }

  if (repoPath) {
    const resolvedRepo = path.resolve(repoPath);
    const resolvedCandidate = path.resolve(rawPath);
    if (resolvedCandidate !== resolvedRepo && !resolvedCandidate.startsWith(resolvedRepo + path.sep)) {
      return false; // absolute path outside the repo root -- a build here would not fix it
    }

    const distDir = distDirFromArtifactPath(resolvedCandidate);
    if (distDir && fs.existsSync(distDir)) {
      // dist/ already exists for this workspace: a missing file inside an
      // already-built dist/ is a different, unrelated bug, not "build
      // required".
      return false;
    }
  }

  return true;
}

const MAX_BUILD_REQUIRED_CAUSE_LENGTH = 160;

function clampBuildRequiredCause(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_BUILD_REQUIRED_CAUSE_LENGTH
    ? `${trimmed.slice(0, MAX_BUILD_REQUIRED_CAUSE_LENGTH - 3)}...`
    : trimmed;
}

export interface BuildRequiredClassification {
  matched: boolean;
  /** The matched line/snippet, present only when `matched` is true. */
  cause?: string;
}

// Classifies a FAILED test check's captured output as "build required"
// (dist/ missing) vs. a genuine failure. Never called directly by
// `checks/test.ts` for an npm-workspaces fan-out -- see
// `classifyBuildRequiredTestFailure` below, which splits a multi-workspace
// failure into per-workspace segments and calls this function on each one
// so one unrelated failing workspace can never hide behind another
// workspace's real build-required evidence. Only reclassifies to `skip`
// when this returns `matched: true`. Scanned line-by-line first for the
// two module/file-not-found shapes (the common case, and the cheapest to
// pinpoint to one line); the precondition phrasing is checked against the
// full text afterwards -- that pattern's `[^\n]{0,120}` gap classes
// explicitly exclude `\n`, so even though it runs against the whole
// multi-line `output` (not one line at a time, unlike the two patterns
// above), a match can never straddle two physical lines.
export function classifyBuildRequiredFailure(
  output: string | undefined,
  repoPath?: string
): BuildRequiredClassification {
  if (!output) {
    return { matched: false };
  }

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!TRUSTED_FAILURE_LINE_PATTERN.test(line)) continue;

    const moduleMatch = DIST_MODULE_NOT_FOUND_PATTERN.exec(line);
    if (moduleMatch && isCredibleBuildArtifactPath(moduleMatch[1], repoPath)) {
      return { matched: true, cause: clampBuildRequiredCause(line) };
    }

    const enoentMatch = DIST_ENOENT_PATTERN.exec(line);
    if (
      enoentMatch &&
      isEnoentModuleResolutionFailure(enoentMatch[1], output) &&
      isCredibleBuildArtifactPath(enoentMatch[1], repoPath)
    ) {
      return { matched: true, cause: clampBuildRequiredCause(line) };
    }
  }

  const preconditionMatch = output.match(DIST_PRECONDITION_PATTERN);
  if (preconditionMatch) {
    return { matched: true, cause: clampBuildRequiredCause(preconditionMatch[0]) };
  }

  return { matched: false };
}

// A single-line preamble npm prints before EACH workspace's own script
// invocation when fanning out via `--workspaces` (e.g. `> needs-build@1.0.0
// test`), distinct from the root script's own preamble (`> test`, no
// `name@version` token). Captures the workspace name so
// `classifyBuildRequiredTestFailure` can name it in a remedy.
const WORKSPACE_PREAMBLE_LINE_PATTERN = /^>\s*([^\s@]+)@\S+\s+\S+\s*$/;

// npm's own lifecycle-failure envelope for one workspace's script, printed
// immediately after that workspace's own output (`npm error Lifecycle
// script ... failed`/`npm error command failed` on current npm; `npm ERR!`
// on older npm majors). Marks a segment (see `splitWorkspaceSegments`) as
// one of the workspaces that actually failed, as opposed to one that ran
// and passed inside the same fan-out.
const WORKSPACE_LIFECYCLE_FAILURE_PATTERN = /npm\s+(?:error|ERR!)\s+(?:Lifecycle script|command failed)/i;

// Splits an npm `--workspaces` fan-out's combined output into one segment
// per workspace, using `WORKSPACE_PREAMBLE_LINE_PATTERN` matches as segment
// starts. Returns undefined when no such preamble is found at all -- a
// single-package repo's `npm run test` (no workspace fan-out), or an
// unrecognized runner/format -- so the caller can fall back to classifying
// the whole output as one blob, same as before this per-workspace split
// existed.
function splitWorkspaceSegments(output: string): string[] | undefined {
  const lines = output.split("\n");
  const boundaries: number[] = [];
  lines.forEach((line, index) => {
    if (WORKSPACE_PREAMBLE_LINE_PATTERN.test(line.trim())) boundaries.push(index);
  });
  if (boundaries.length === 0) return undefined;

  return boundaries.map((start, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
    return lines.slice(start, end).join("\n");
  });
}

function workspaceNameFromSegment(segment: string): string | undefined {
  const firstLine = segment.split("\n", 1)[0]?.trim() ?? "";
  return WORKSPACE_PREAMBLE_LINE_PATTERN.exec(firstLine)?.[1];
}

export interface BuildRequiredTestClassification extends BuildRequiredClassification {
  /** Names of the workspaces whose own output carried the build-required evidence, when known. */
  workspaceNames?: string[];
}

// Entry point used by `checks/test.ts` for the default auto-detected
// `npm run test` check. A monorepo's `npm test` that fans out across
// `--workspaces` can fail for MULTIPLE, INDEPENDENT reasons at once -- one
// workspace missing its build, another with a genuinely broken test -- and
// a single blob-wide `classifyBuildRequiredFailure` call would downgrade
// the WHOLE check to a non-blocking skip the moment ANY line anywhere in
// the combined output happened to carry build-required evidence, hiding
// the other workspace's real, unrelated failure. This splits the output
// into per-workspace segments (`splitWorkspaceSegments`) and only
// downgrades when EVERY workspace segment that actually failed
// (`WORKSPACE_LIFECYCLE_FAILURE_PATTERN`) is, on its own, build-required
// evidence; one genuinely-failing workspace anywhere in the fan-out keeps
// the whole check a blocking `fail`. When no per-workspace preamble is
// found at all (not an npm-workspaces fan-out, or an unrecognized runner),
// falls back to classifying the whole output as one blob -- unchanged
// behavior for a single-package repo.
export function classifyBuildRequiredTestFailure(
  output: string | undefined,
  repoPath?: string
): BuildRequiredTestClassification {
  if (!output) return { matched: false };

  const segments = splitWorkspaceSegments(output);
  if (!segments) {
    return classifyBuildRequiredFailure(output, repoPath);
  }

  const failingSegments = segments.filter((segment) => WORKSPACE_LIFECYCLE_FAILURE_PATTERN.test(segment));
  if (failingSegments.length === 0) {
    // Could not attribute the failure to a specific workspace (unexpected
    // shape, e.g. a custom `--if-present` runner that doesn't echo npm's
    // own lifecycle envelope) -- fall back to the whole-output classifier
    // rather than guessing which segment is at fault.
    return classifyBuildRequiredFailure(output, repoPath);
  }

  const perSegment = failingSegments.map((segment) => ({
    segment,
    classification: classifyBuildRequiredFailure(segment, repoPath),
  }));

  if (!perSegment.every((s) => s.classification.matched)) {
    // At least one failing workspace's own output carries no build-required
    // evidence: a genuine failure exists alongside (or instead of) any
    // build-required workspace, so the whole check stays a blocking fail.
    return { matched: false };
  }

  const first = perSegment[0]?.classification ?? { matched: false };
  const workspaceNames = perSegment
    .map((s) => workspaceNameFromSegment(s.segment))
    .filter((name): name is string => Boolean(name));
  return { ...first, workspaceNames: workspaceNames.length > 0 ? workspaceNames : undefined };
}

// Build-invocation / test-invocation shapes recognized in a single-line
// `run:` workflow step (see `ciShowsBuildBeforeTest`'s own comment for what
// this does and does not model).
const CI_BUILD_STEP_PATTERN = /\b(?:npm|yarn|pnpm)\s+run\s+build\b|\b(?:yarn|pnpm)\s+build\b/i;
const CI_TEST_STEP_PATTERN = /\bnpm\s+test\b|\b(?:npm|yarn|pnpm)\s+run\s+test\b|\b(?:yarn|pnpm)\s+test\b/i;

// Best-effort, conservative detection of "this repo's CI builds before it
// tests", read from `.github/workflows/ci.yml` -- the exact file the
// reported friction pointed at (a repo's real CI convention contradicting
// preflight's own verdict). Deliberately narrow, and defaults to `false`
// (no extra build step) whenever it cannot tell:
//
// - Only the single named file `.github/workflows/ci.yml` is read; other
//   workflow files, reusable workflows, and composite actions are not
//   consulted.
// - Only single-line `run: <command>` steps are recognized (a YAML block
//   scalar `run: |` followed by more lines is not parsed for its body).
// - Ordering is by RAW LINE NUMBER in the file, not by GitHub Actions' own
//   job/step/`needs:` execution graph -- a multi-job workflow where a
//   later-listed job actually runs first (via `needs:`), or a matrix build,
//   is not modeled. In the common single-job "steps: build, then test"
//   shape (this project's own CI included) that is exactly the execution
//   order too.
// - The command must match one of the common `npm|yarn|pnpm run build`
//   invocations; a custom build entry point (a Makefile target, a
//   standalone script not run through the package manager) is not
//   recognized.
// - Job/`needs:` graph blindness cuts both ways: a build step in a job
//   that never actually runs before (or alongside) the test job -- an
//   unrelated job listed earlier in the file, a matrix leg that only
//   builds a different target -- is still read as "build before test" by
//   raw line order, even though the two steps have no real relationship.
//
// These gaps do NOT have a uniform direction, unlike an earlier version of
// this comment claimed. A false MISS (a real build-before-test convention
// this reader cannot see, e.g. a `run: |` block scalar or a reusable
// workflow) only costs the extra manual `npm run build` this feature
// exists to avoid -- `--setup` behaves exactly as it did before this
// feature (dependency install only). A false HIT (an unrelated job's build
// step, or -- before the `echo`/comment guards below existed -- a `run:`
// line that only PRINTS the words "npm run build" without invoking it)
// only costs a redundant rebuild under `--setup`: harmless but wasted
// time, never a build the repo does not actually want. Neither direction
// causes `--setup` to skip a build the repo's real CI relies on.
//
// Two `run:` shapes are excluded before either pattern is tested, because
// they name the words without executing the command: a step whose value is
// itself a shell comment (`run: # npm run build` -- the value starts with
// `#`, a no-op in `sh`/`bash`), and a step that only echoes a string
// (`run: echo 'npm run build is documented'`) rather than running it.
export function ciShowsBuildBeforeTest(repoPath: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoPath, ".github", "workflows", "ci.yml"), "utf-8");
  } catch {
    return false;
  }
  return workflowTextShowsBuildBeforeTest(text);
}

// Exported separately from `ciShowsBuildBeforeTest` so a test can exercise
// the parsing logic directly against inline workflow text instead of
// writing a fixture file to disk for every case.
export function workflowTextShowsBuildBeforeTest(text: string): boolean {
  const lines = text.split("\n");
  let buildLine = -1;
  let testLine = -1;

  lines.forEach((line, index) => {
    const stepMatch = /^\s*-?\s*run:\s*(.+)$/.exec(line);
    if (!stepMatch) return;
    const command = stepMatch[1].trim();
    if (command.startsWith("#")) return; // the step's value is itself a shell comment; nothing runs
    if (/^echo\b/i.test(command)) return; // prints a string; does not invoke the named command
    if (buildLine === -1 && CI_BUILD_STEP_PATTERN.test(command)) buildLine = index;
    if (testLine === -1 && CI_TEST_STEP_PATTERN.test(command)) testLine = index;
  });

  return buildLine !== -1 && testLine !== -1 && buildLine < testLine;
}

// Patterns emitted when a shell directly reports "this binary is missing
// or not executable" inside a wrapper invocation. Used by `runShellCheck`
// when the caller opted into `treatToolNotFoundAsLimitation`. Kept narrow
// on purpose: only the shell's own error lines count, so a legitimate
// non-zero exit (deliberate `exit 127`, lint violations, npm error code
// envelope without an underlying sh failure) stays a fail.
//
// - `: command not found`: POSIX sh, dash, bash error on missing PATH entry.
// - `: Permission denied`: bash error when a found file is not executable
//   (seen e.g. with non-executable workspace `node_modules/.bin/eslint`).
//
// Real-world npm-wrapped missing-tool failures always include one of these
// lines in their output before npm prints its own error envelope, so we do
// not need to match `npm error code 127` or similar wrapper-emitted lines
// (which would also match a deliberate `exit 127` in a workspace script).
// See `tests/workspace.test.ts` for the contract preserved here.
//
// Anchor each match to end-of-line and require the colon-space prefix so a
// lint violation that mentions "command not found" as content does not
// trigger the heuristic.
function looksLikeMissingTool(output: string | undefined): boolean {
  if (!output) return false;
  return output.split("\n").some((line) =>
    /:\s*command not found\s*$/i.test(line) ||
    /:\s*Permission denied\s*$/i.test(line)
  );
}

export async function commandExists(command: string, repoPath: string): Promise<boolean> {
  const { exitCode } = await execa(
    "bash",
    ["-c", 'command -v "$CHECK_CMD" >/dev/null 2>&1'],
    {
      cwd: repoPath,
      reject: false,
      env: {
        ...buildCommandEnv(repoPath),
        CHECK_CMD: command,
      },
    }
  );

  return exitCode === 0;
}

export function fileExists(repoPath: string, relativePath: string): boolean {
  return fs.existsSync(path.join(repoPath, relativePath));
}

// Outcome of the `--setup` build step (see `ensureProjectSetup`'s "Option
// (a)" block below), threaded into `checks/test.ts` via `runTestChecks`'s
// third parameter so a build failure under `--setup` is never silently
// swallowed into a `limitations` string while the test check downstream
// gets misclassified as "build required, not yet run" (agent-tasks
// c5810885 review round 2, HIGH-2). `attempted` is always `true` when this
// object exists at all -- the field exists so a caller destructuring an
// `outcome?: SetupBuildOutcome | undefined` can tell "never ran" (the
// whole value is undefined -- no build script, or CI doesn't show
// build-before-test) from "ran and definitely finished" without a second
// optional check.
export interface SetupBuildOutcome {
  attempted: true;
  succeeded: boolean;
  timedOut: boolean;
  exitCode?: number;
  /** Path the build's full stdout+stderr was persisted to, when available. */
  logPath?: string;
}

export interface ProjectSetupResult {
  limitations: string[];
  buildOutcome?: SetupBuildOutcome;
}

export async function ensureProjectSetup(repoPath: string, logDir?: string): Promise<ProjectSetupResult> {
  const limitations: string[] = [];
  const context = createProjectContext(repoPath);
  let buildOutcome: SetupBuildOutcome | undefined;

  if (hasNodeProject(context) && fileExists(repoPath, "package-lock.json") && !fileExists(repoPath, "node_modules")) {
    const result = await runSetupCommand(repoPath, "npm ci");
    if (result.exitCode === 127) {
      limitations.push("package-lock.json found but node_modules/ is missing; npm ci skipped because npm is not available");
    } else if (result.exitCode !== 0) {
      limitations.push("npm ci failed while preparing Node checks");
    }
  }

  // Option (a) from the build-required decision (see checks/test.ts and
  // README's "Build-required test classification"): behind `--setup` only,
  // and only when BOTH a `build` script exists AND this repo's own CI
  // workflow demonstrably builds before it tests (`ciShowsBuildBeforeTest`,
  // conservative by construction -- see that function's comment). Runs
  // unconditionally when both hold (no "is dist already there" marker
  // check, since a workspaces monorepo has no single root dist/ to probe):
  // a redundant rebuild costs time but is otherwise harmless, whereas
  // skipping it on a stale guess would reintroduce the very failure this
  // feature exists to avoid.
  //
  // The outcome (not just a limitations string) is captured into
  // `buildOutcome` and returned so `runTestChecks` can tell "the repo has
  // simply not been built yet" (fine to downgrade to a named skip) from
  // "the repo's build itself just failed under --setup" (a real,
  // newly-observed break -- must stay a blocking fail, never a skip; see
  // HIGH-2 in the round-2 review). Full stdout+stderr is captured (`all:
  // true` inside `runSetupCommand`) and persisted the same way
  // `runShellCheck` persists a failing check's output, so the actual build
  // error is reachable even though this path never produces its own
  // `CheckResult`.
  if (hasNodeProject(context) && context.packageJson?.scripts?.build && ciShowsBuildBeforeTest(repoPath)) {
    const result = await runSetupCommand(repoPath, "npm run build");
    if (result.exitCode === 127) {
      limitations.push("package.json has a build script but npm is not available; --setup build step skipped");
    } else if (result.timedOut) {
      const logPath = result.output ? persistFailureOutput(logDir, "npm-run-build-setup", result.output) : undefined;
      limitations.push(
        `npm run build timed out while preparing the test check (--setup)${logPath ? ` (see ${logPath})` : ""}`
      );
      buildOutcome = { attempted: true, succeeded: false, timedOut: true, logPath };
    } else if (result.exitCode !== 0) {
      const logPath = result.output ? persistFailureOutput(logDir, "npm-run-build-setup", result.output) : undefined;
      limitations.push(
        `npm run build failed (exit code ${result.exitCode}) while preparing the test check (--setup)${logPath ? ` (see ${logPath})` : ""}`
      );
      buildOutcome = { attempted: true, succeeded: false, timedOut: false, exitCode: result.exitCode, logPath };
    } else {
      buildOutcome = { attempted: true, succeeded: true, timedOut: false, exitCode: result.exitCode };
    }
  }

  if (hasPythonProject(context) && context.hasRequirementsTxt && !fileExists(repoPath, ".preflight-venv")) {
    const result = await runSetupCommand(
      repoPath,
      "python3 -m venv .preflight-venv && .preflight-venv/bin/pip install -r requirements.txt"
    );
    if (result.exitCode === 127) {
      limitations.push("requirements.txt found but .preflight-venv/ is missing; Python setup skipped because python3 is not available");
    } else if (result.exitCode !== 0) {
      limitations.push("Python environment setup failed while preparing checks");
    }
  }

  if (hasPhpProject(context) && !fileExists(repoPath, "vendor")) {
    const result = await runSetupCommand(repoPath, "composer install --no-interaction --no-progress");
    if (result.exitCode === 127) {
      limitations.push("composer.json found but vendor/ is missing; composer install skipped because composer is not available");
    } else if (result.exitCode !== 0) {
      limitations.push("composer install failed while preparing PHP checks");
    }
  }

  if (context.hasMavenWrapper || context.hasPomXml) {
    const command = context.hasMavenWrapper
      ? "./mvnw -q -DskipTests dependency:go-offline"
      : "mvn -q -DskipTests dependency:go-offline";
    const marker = path.join(repoPath, "target");
    if (!fs.existsSync(marker)) {
      const result = await runSetupCommand(repoPath, command);
      if (result.exitCode === 127) {
        limitations.push("pom.xml found but Maven setup skipped because mvn is not available");
      } else if (result.exitCode !== 0) {
        limitations.push("Maven setup failed while preparing Java checks");
      }
    }
  }

  if (context.hasGradleWrapper || context.hasGradleBuild) {
    const command = context.hasGradleWrapper
      ? "./gradlew classes testClasses -q"
      : "gradle classes testClasses -q";
    const marker = path.join(repoPath, ".gradle");
    if (!fs.existsSync(marker)) {
      const result = await runSetupCommand(repoPath, command);
      if (result.exitCode === 127) {
        limitations.push("build.gradle found but Gradle setup skipped because gradle is not available");
      } else if (result.exitCode !== 0) {
        limitations.push("Gradle setup failed while preparing Java checks");
      }
    }
  }

  return { limitations, buildOutcome };
}

export function getWorkingDirHint(repoPath: string): string | undefined {
  return createProjectContext(repoPath).suggestedWorkingDir;
}

export function shouldSkipRecursiveNodeTest(repoPath: string, command: string): boolean {
  if (!process.env.VITEST) {
    return false;
  }

  const normalized = command.trim();
  const isNodeTestCommand =
    normalized === "npm test" ||
    normalized === "npm run test" ||
    normalized === "pnpm test" ||
    normalized === "yarn test" ||
    normalized === "vitest" ||
    normalized.startsWith("vitest ") ||
    normalized.startsWith("npx vitest");

  if (!isNodeTestCommand) {
    return false;
  }

  return path.resolve(repoPath) === path.resolve(process.cwd());
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function findSuggestedWorkingDir(repoPath: string, targetFile: string): string | undefined {
  const matches = findNestedFiles(repoPath, targetFile, 3);
  if (matches.length !== 1) {
    return undefined;
  }

  return path.dirname(matches[0]);
}

function findNestedFiles(repoPath: string, targetFile: string, maxDepth: number): string[] {
  const matches: string[] = [];
  const skipDirs = new Set([
    ".git",
    ".idea",
    ".next",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "tmp",
    "vendor",
  ]);

  scan(repoPath, 0);
  return matches;

  function scan(currentPath: string, depth: number): void {
    if (depth > maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        continue;
      }

      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          continue;
        }
        scan(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name === targetFile && currentPath !== repoPath) {
        matches.push(path.relative(repoPath, entryPath));
      }
    }
  }
}

function outputLines(output: string | undefined): string[] | undefined {
  if (!output) {
    return undefined;
  }

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);

  return lines.length > 0 ? lines : undefined;
}

// Default location for the full-output logs written by `computeFailureDetails`
// when a caller of `runShellCheck` does not override `ShellCheckOptions.logDir`.
// Kept as a function (not a module-level constant) so it always reflects the
// current `os.homedir()` rather than a value captured at import time — and
// resolved LAZILY inside persistFailureOutput's try, so even a throwing
// os.homedir() degrades to the outputLines() fallback instead of escaping
// the check path (the never-throw invariant covers this seam too).
function defaultLogDir(): string {
  return path.join(os.homedir(), ".agent-preflight", "logs");
}

// Lines that vitest/jest emit to call out a failing test, matched against the
// trimmed line so leading indentation doesn't matter:
// - "FAIL <file>" / "FAIL <file> > <describe> > <test>" (both frameworks)
// - "× " / "✗ " (vitest per-test failure marker)
// - "❯ " (vitest failing-file summary line)
// - "● " (jest per-test failure bullet)
// See harness#356: the first details line is pinned to `full output: <path>`
// and failure lines are pinned to the `FAIL <file> > <testname>` shape, so
// this pattern intentionally stays narrow rather than trying to detect every
// possible test-runner output style.
//
// Precision decision (fail-log hardening review, task 016425e6): these bare
// glyphs (×, ✗, ❯, ●) are not exclusive to vitest/jest — a lint tool's own
// output, a captured shell prompt fragment (❯ is a common custom-prompt
// character), or an unrelated bullet list could contain them too, and would
// then be surfaced in `details` as if it were a parsed failure line. The
// bullet markers are required here to be followed by whitespace (matching
// every real vitest/jest marker: "× foo", "❯ tests/x.ts", "● Component ›
// renders"), which rules out glyphs glued to other punctuation with no gap.
// This is a cheap, safe narrowing — it does not touch any of the existing
// fixtures below — but it is deliberately NOT airtight: a bare "● " bullet
// in some other tool's output can still slip through. That residual risk is
// accepted as best-effort rather than chased further, because
// `parseFailureLines` only ever runs on a check that has ALREADY failed
// (the exit code decided that) and only selects which lines to show in the
// informational `details` array — it never flips `pass`/`fail`, `ready`, or
// `confidence`. Worst case is a slightly noisier detail line on a real
// failure, not a misclassified check. When nothing matches, the existing
// first-10-lines fallback in `computeFailureDetails` still applies, so no
// information is ever lost either way.
const FAILURE_LINE_PATTERN = /^(FAIL\s|[×✗❯●]\s)/;

function parseFailureLines(output: string | undefined): string[] {
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && FAILURE_LINE_PATTERN.test(line));
}

// Builds the `details` array for a failing check: best-effort persistence of
// the complete `all` output to a log file, followed by the parsed failure
// lines (or, if none match, the previous first-10-non-empty-lines behavior).
// Never throws — any fs error degrades to the pre-existing `outputLines`
// behavior so a failure in the logging path can never mask or alter the
// check's own pass/fail result.
function computeFailureDetails(
  logDir: string | undefined,
  checkName: string,
  output: string | undefined
): string[] | undefined {
  if (!output) {
    return outputLines(output);
  }

  const logPath = persistFailureOutput(logDir, checkName, output);
  if (!logPath) {
    return outputLines(output);
  }

  const failureLines = parseFailureLines(output).slice(0, 10);
  const bodyLines = failureLines.length > 0 ? failureLines : outputLines(output) ?? [];
  return [`full output: ${logPath}`, ...bodyLines];
}

// Monotonically increasing per-process counter appended to log filenames,
// together with the current process id, so two failures of the same check
// never collide (and silently overwrite each other's log file):
// - Two failures in the *same* process within the same millisecond are
//   distinguished by the counter (it only ever goes up for the life of the
//   process).
// - Two failures from *different* preflight processes (e.g. two `preflight
//   batch` runs, or a CI job and a local run, sharing the default
//   `~/.agent-preflight/logs`) landing on the same millisecond are
//   distinguished by `process.pid`, since each process was assigned its own
//   pid by the OS for its lifetime.
// This is a best-effort naming scheme, not a filesystem lock — an OS
// reusing a pid within the exact same millisecond a prior process with that
// pid also wrote seq N would still collide, but that is far outside what
// this feature needs to guard against in practice.
let logFileSequence = 0;

function sanitizeLogFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

// Any file rotation considers "ours" ends in
// `-<epoch-ms>-<pid>-<sequence>.log`, matching exactly what
// `persistFailureOutput` writes below. Files that don't match either this or
// `LEGACY_LOG_FILE_PATTERN` (e.g. logs dropped into the same directory by
// another tool) are never touched by rotation. The three captured groups
// double as the deterministic sort key `rotateLogFiles` uses below (see
// `parseRotationKey`).
//
// Precision decision (fail-log hardening review, task 016425e6): a
// width-unbounded `\d+` for the first (epoch-ms) group matches any
// dash-number-count shape, not just an actual timestamp; an nginx-style
// dated log (`nginx-2026-08-17.log`, three dash-separated groups: year,
// month, day) or a monthly backup log (`backup-2026-08.log`, two groups)
// dropped into the same directory by another tool would satisfy the group
// count alone. Misclassifying such a file as "ours" makes it eligible for
// silent deletion by rotation, since its tiny fake "epoch" sorts as the
// oldest entry. `Date.now()` is 13 digits for the entire lifetime of this
// feature (already past 1e12 in 2001, not reaching 1e14 until the year
// 5138), so `\d{13,}` accepts every real epoch-ms value while rejecting
// short numeric groups like a calendar year or month that happen to share
// the file-naming shape.
const OWN_LOG_FILE_PATTERN = /-(\d{13,})-(\d+)-(\d+)\.log$/;

// Filenames written by the pre-0.4.0 fail-log feature (task 6691dd56 / PR
// #45), before `persistFailureOutput` started embedding `process.pid`:
// `<check>-<epoch-ms>-<sequence>.log` — two number groups instead of three.
// `OWN_LOG_FILE_PATTERN` stopped matching these the moment the pid segment
// was added (task 016425e6), which orphaned any log file already on disk
// from a prior install: `rotateLogFiles` no longer counted them, so they
// could never be picked for deletion and would sit in the directory forever
// alongside the current 20-file cap instead of draining through it. This
// predicate re-admits a legacy-named file into the same rotation pass (see
// `parseRotationKey`'s synthetic key for it) so it ages out normally. This
// is a one-time drain: once a legacy file rotates out, nothing ever writes
// that shape again, so the directory converges back to pure current-format
// files and this pattern stops matching anything.
//
// Same `\d{13,}` epoch-width guard as `OWN_LOG_FILE_PATTERN` above, for
// the same reason: without it, a two-dash-number-group foreign file like
// `backup-2026-08.log` would match this pattern too and become eligible for
// silent deletion by rotation.
const LEGACY_LOG_FILE_PATTERN = /-(\d{13,})-(\d+)\.log$/;

function persistFailureOutput(
  logDir: string | undefined,
  checkName: string,
  output: string
): string | undefined {
  try {
    const dir = logDir ?? defaultLogDir();
    fs.mkdirSync(dir, { recursive: true });
    logFileSequence += 1;
    const fileName = `${sanitizeLogFileName(checkName)}-${Date.now()}-${process.pid}-${logFileSequence}.log`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, output);
    rotateLogFiles(dir);
    return filePath;
  } catch {
    // Best-effort: a read-only logDir, a full disk, etc. must never throw
    // out of the check path. The caller falls back to the pre-existing
    // outputLines() behavior when this returns undefined.
    return undefined;
  }
}

const MAX_LOG_FILES = 20;

// (epochMs, pid, sequence) extracted from a filename that already matched
// `OWN_LOG_FILE_PATTERN` or `LEGACY_LOG_FILE_PATTERN`. Used to sort
// oldest-first for rotation.
type RotationKey = readonly [epochMs: number, pid: number, sequence: number];

// The filename already carries a deterministic sort key — reading it back
// out of the name lets rotation sort oldest-first without a single
// `statSync` call (and without the mtime-can-be-touched-by-other-tools
// ambiguity a stat-based sort would have). `OWN_LOG_FILE_PATTERN` and
// `LEGACY_LOG_FILE_PATTERN` are the single source of truth for both "is
// this ours" and "what's its key": a current-format match yields the real
// `(epochMs, pid, sequence)` triple; a legacy match (no pid segment) yields
// a synthetic `[epochMs, 0, 0]` so it sorts purely by its own timestamp and
// drains through the same 20-file cap as current-format files instead of
// being permanently skipped.
function parseRotationKey(fileName: string): RotationKey {
  const ownMatch = fileName.match(OWN_LOG_FILE_PATTERN);
  if (ownMatch) {
    return [Number(ownMatch[1]), Number(ownMatch[2]), Number(ownMatch[3])];
  }
  const legacyMatch = fileName.match(LEGACY_LOG_FILE_PATTERN);
  if (legacyMatch) {
    return [Number(legacyMatch[1]), 0, 0];
  }
  // Defensive fallback only: every caller filters with `isOwnOrLegacyLogFile`
  // first, so reaching here should be unreachable.
  return [0, 0, 0];
}

function compareRotationKeys(a: RotationKey, b: RotationKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isOwnOrLegacyLogFile(fileName: string): boolean {
  return OWN_LOG_FILE_PATTERN.test(fileName) || LEGACY_LOG_FILE_PATTERN.test(fileName);
}

function rotateLogFiles(logDir: string): void {
  try {
    const ownLogFiles = fs
      .readdirSync(logDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isOwnOrLegacyLogFile(entry.name))
      .map((entry) => ({ name: entry.name, key: parseRotationKey(entry.name) }))
      .sort((a, b) => compareRotationKeys(a.key, b.key));

    const excess = ownLogFiles.length - MAX_LOG_FILES;
    for (let i = 0; i < excess; i += 1) {
      try {
        fs.unlinkSync(path.join(logDir, ownLogFiles[i].name));
      } catch {
        // Best-effort; a concurrent delete should not fail the check.
      }
    }
  } catch {
    // Rotation is best-effort and must never throw out of the check path.
  }
}

function buildCommandEnv(repoPath: string): NodeJS.ProcessEnv {
  const pathEntries = [
    path.join(repoPath, ".preflight-venv", "bin"),
    path.join(repoPath, "node_modules", ".bin"),
    process.env.PATH ?? "",
  ].filter(Boolean);

  return {
    ...process.env,
    PATH: pathEntries.join(":"),
  };
}

interface SetupCommandResult {
  exitCode: number;
  timedOut: boolean;
  /** Combined stdout+stderr, when the command actually ran. */
  output?: string;
}

async function runSetupCommand(repoPath: string, command: string): Promise<SetupCommandResult> {
  const { exitCode, all, timedOut } = await execa(
    "bash",
    ["-c", command],
    {
      cwd: repoPath,
      reject: false,
      all: true,
      timeout: 120_000,
      env: buildCommandEnv(repoPath),
    }
  );

  return { exitCode: exitCode ?? 1, timedOut: Boolean(timedOut), output: all };
}
