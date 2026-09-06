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
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  // Entry points a package declares as its own build output; read by
  // `declaredBuildArtifacts` for the build precondition. `exports` stays
  // `unknown` because its value is a freeform nested condition/subpath tree.
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
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
  // caller can inspect a `fail` result's own output (see
  // `evaluateBuildRequiredTestFailure` and its use in checks/test.ts)
  // without `runShellCheck` needing to know about that evaluation itself.
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

// ---------------------------------------------------------------------------
// Build-required test failures
// ---------------------------------------------------------------------------
//
// A failing `npm test` is only ever downgraded from a blocking `fail` to the
// named `skip` outcome ("build required before test") when the FILESYSTEM
// says the failing package cannot have been built yet: it has a `build`
// script, and at least one of the artifacts it declares is not on disk
// (`evaluateBuildPrecondition`). Runner output text does not decide that.
// Deciding from text was the design that kept producing false skips -- a
// single `Cannot find module '<...>/dist/cli.js'` line next to a real
// assertion failure downgraded the whole check -- so the decision now rests
// on state that a build actually changes.
//
// Text is still read, for two things that are not the decision:
//   - attribution: npm's own per-workspace preambles say WHICH package
//     failed, so the precondition is evaluated against that package's
//     directory rather than the repo root (`splitWorkspaceSegments`);
//   - corroboration: `findMissingArtifactEvidence` requires the failing
//     package's own output to actually blame the missing artifact before the
//     downgrade is allowed, and supplies the error line quoted in the
//     message.
//
// Both conditions are necessary and neither is sufficient. The precondition
// answers "could a build change this outcome at all"; the corroboration
// answers "is THIS failure about the missing artifact". Without the
// precondition, any output line could downgrade a genuine failure (the
// round-2 defect). Without the corroboration, every failure in an unbuilt
// checkout would be downgraded, including one that has nothing to do with
// the build -- a package that compiles to `dist/` but runs its tests from
// source (this very repo) would report `ready: true` for a genuinely broken
// suite.
//
// The corroboration is a PATH rule, never a text match. Every path-shaped
// token on a line is resolved (absolute as printed, `./`/`../` against the
// failing package's own directory) and accepted only when the resolved path
// is the missing artifact or lies inside the build-output directory that
// artifact identifies, is inside the repository, carries no `node_modules`
// segment, and belongs to the failing package rather than a neighbour. A
// substring test in its place accepted a stale relative require in an unbuilt
// package, a dependency missing under `node_modules/<lib>/dist/`, another
// workspace's artifact, and any runner stack frame through
// `node_modules/vitest/dist/` -- each of them hiding a genuinely broken
// package behind `ready: true`.
//
// What stays indistinguishable, by construction: a genuine failure whose own
// error path lies inside the package's own missing build output (a stale
// reference to a `dist/old.js` that a build would not recreate). Nothing on
// disk separates that from "not built yet" until a build has run, and the
// remedy the skip names -- run the build, or rerun with `--setup` -- is
// exactly what resolves it either way.

// `exports` conditions whose targets are treated as declared build output.
// Other conditions (`node-addons`, `browser`, custom ones) are not walked:
// they either duplicate these targets or name something a plain build does
// not produce.
const EXPORTS_CONDITIONS = new Set(["import", "require", "default", "types"]);

// Collects the string leaves of a `package.json` `exports` field: subpath
// keys (`"."`, `"./sub"`) and the conditions above are walked, arrays are
// walked element-wise, `null` (a blocked subpath) is ignored.
function collectExportsTargets(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectExportsTargets(entry, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith(".") || EXPORTS_CONDITIONS.has(key)) {
        collectExportsTargets(value, out);
      }
    }
  }
}

// Conventional output directory, used only as the fallback for a package
// that declares no entry points at all (common for a `private` workspace
// whose tests require `./dist/...` directly).
const DEFAULT_BUILD_OUTPUT_DIR = "dist";

// Every path a package declares as its own build output, relative to its own
// directory: `main`, `module`, `types`/`typings`, `bin` (string form or every
// value of the map form), the string leaves of `exports`, and the `outDir` of
// the package's own `tsconfig.json` when that file parses and declares one (a
// tsconfig with comments does not parse as JSON and is simply skipped, the
// same way every other optional manifest in this file is read). Order is
// stable, so the artifact named in a message is deterministic. A target
// containing `*` (an `exports` subpath pattern) is dropped: a wildcard cannot
// be existence-checked.
function declaredBuildArtifacts(pkgDir: string, pkg: PackageJson | undefined): string[] {
  const raw: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) raw.push(value.trim());
  };

  push(pkg?.main);
  push(pkg?.module);
  push(pkg?.types);
  push(pkg?.typings);
  if (typeof pkg?.bin === "string") {
    push(pkg.bin);
  } else if (pkg?.bin && typeof pkg.bin === "object") {
    for (const value of Object.values(pkg.bin)) push(value);
  }
  collectExportsTargets(pkg?.exports, raw);

  const tsconfig = readJsonFile<{ compilerOptions?: { outDir?: unknown } }>(
    path.join(pkgDir, "tsconfig.json")
  );
  push(tsconfig?.compilerOptions?.outDir);

  return [...new Set(raw.filter((entry) => !entry.includes("*")))];
}

// A declared artifact counts as present when its path exists, or -- for an
// extensionless declaration such as `main: "./dist/index"`, which Node
// resolves by trying extensions and then `index.js` -- when one of Node's
// resolution candidates exists. Without that, a package that IS built but
// declares an extensionless entry point would read as unbuilt.
const ARTIFACT_RESOLUTION_EXTENSIONS = [".js", ".cjs", ".mjs", ".json", ".d.ts"];
function buildArtifactExists(absPath: string): boolean {
  if (fs.existsSync(absPath)) return true;
  if (path.extname(absPath).length > 0) return false;
  return (
    ARTIFACT_RESOLUTION_EXTENSIONS.some((ext) => fs.existsSync(absPath + ext)) ||
    fs.existsSync(path.join(absPath, "index.js"))
  );
}

// Whether a root `build` script fans out over the workspaces
// (`npm run build --workspaces ...`, `npm run build -ws`). This decides only
// WHICH REMEDY a skip message names -- `npm run build` at the root, which is
// also all `--setup` ever runs, versus a workspace-scoped build -- never
// whether a package counts as covered by a build script.
//
// It deliberately does NOT grant a build script to a workspace that has none
// of its own. An `--if-present` fan-out skips exactly such a workspace, so the
// build it promises is a no-op there; and a fan-out WITHOUT `--if-present`
// would fail outright on a workspace with no `build` script, so a repo that
// runs one has a build script in every workspace anyway. Either way the
// workspace's own `scripts.build` is the honest test, and requiring it is what
// keeps a genuinely broken workspace (which typically has no build at all)
// from being read as "not built yet".
const ROOT_WORKSPACES_BUILD_PATTERN = /\brun\s+build\b[^\n]*?(?:--workspaces\b|(?:^|\s)-ws(?:\s|$))/i;

export function rootBuildScriptFansOutToWorkspaces(rootPkg: PackageJson | undefined): boolean {
  const script = rootPkg?.scripts?.build;
  return typeof script === "string" && ROOT_WORKSPACES_BUILD_PATTERN.test(script);
}

export interface BuildPreconditionResult {
  /** True when a build script covers this package AND a declared artifact is missing on disk. */
  met: boolean;
  /** Whether a build script that could produce this package's artifacts exists at all. */
  hasBuildScript: boolean;
  /** The first missing artifact, as declared (package-relative), when one is missing. */
  missingArtifact?: string;
}

// The filesystem precondition (see the block comment above). `pkgDir` is the
// package the failure was attributed to -- a workspace directory, or the repo
// root itself for a single-package repo or an unattributable failure. It is a
// property of that package alone: only its own manifest and its own files on
// disk decide, which is why no repository path is needed here.
export function evaluateBuildPrecondition(pkgDir: string): BuildPreconditionResult {
  const pkg = readJsonFile<PackageJson>(path.join(pkgDir, "package.json"));

  const hasBuildScript = Boolean(pkg?.scripts?.build);
  if (!hasBuildScript) {
    return { met: false, hasBuildScript: false };
  }

  const declared = declaredBuildArtifacts(pkgDir, pkg);
  const candidates = declared.length > 0 ? declared : [DEFAULT_BUILD_OUTPUT_DIR];
  const missingArtifact = candidates.find(
    (relative) => !buildArtifactExists(path.resolve(pkgDir, relative))
  );

  return { met: missingArtifact !== undefined, hasBuildScript: true, missingArtifact };
}

// npm prints `> <name>@<version> <script>` before each workspace's own script
// during a `--workspaces` fan-out. The ROOT package's own script gets the same
// shape whenever the root `package.json` carries a `version` (npm 11 prints
// `> repo@1.2.3 test`), so the root line is filtered out by identity below
// rather than assumed to look different. The optional `@scope/` prefix is part
// of the name, not a version separator.
const PACKAGE_PREAMBLE_LINE_PATTERN = /^>\s*((?:@[^\s@/]+\/)?[^\s@/]+)@([^\s@]+)\s+\S+\s*$/;

// npm's own lifecycle-failure envelope for one workspace's script, printed
// immediately after that workspace's output (`npm error Lifecycle script ...
// failed` / `npm error command failed` on current npm, `npm ERR!` on older
// majors). Marks a segment as one of the workspaces that actually failed, as
// opposed to one that ran and passed inside the same fan-out.
const WORKSPACE_LIFECYCLE_FAILURE_PATTERN = /npm\s+(?:error|ERR!)\s+(?:Lifecycle script|command failed)/i;

// Splits an npm `--workspaces` fan-out's combined output into one segment per
// workspace, using the preamble lines as segment starts and excluding the root
// package's own preamble. Returns undefined when no workspace preamble is left
// -- a single-package repo, or an unrecognized runner -- so the caller falls
// back to treating the whole output as the root package's.
export function splitWorkspaceSegments(
  output: string,
  rootPackage?: { name?: string; version?: string }
): string[] | undefined {
  const lines = output.split("\n");
  const boundaries: number[] = [];

  lines.forEach((line, index) => {
    const match = PACKAGE_PREAMBLE_LINE_PATTERN.exec(line.trim());
    if (!match) return;
    const isRootPreamble =
      Boolean(rootPackage?.name) &&
      match[1] === rootPackage?.name &&
      (rootPackage?.version === undefined || match[2] === rootPackage.version);
    if (isRootPreamble) return;
    boundaries.push(index);
  });

  if (boundaries.length === 0) return undefined;

  return boundaries.map((start, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
    return lines.slice(start, end).join("\n");
  });
}

function workspaceNameFromSegment(segment: string): string | undefined {
  const firstLine = segment.split("\n", 1)[0]?.trim() ?? "";
  return PACKAGE_PREAMBLE_LINE_PATTERN.exec(firstLine)?.[1];
}

// Maps every package name found in the repo (up to three directory levels,
// `node_modules`/`dist`/etc. skipped by `findNestedFiles`) to its directory,
// so a workspace named in npm's preamble is resolved to the directory whose
// precondition is then evaluated. Name and directory routinely differ
// (`packages/z-broken` publishing as `broken`, a scoped name under a plain
// directory), which is why the name is looked up rather than joined onto
// `packages/`.
function buildPackageDirIndex(repoPath: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const dir of collectPackageDirs(repoPath)) {
    const pkg = readJsonFile<PackageJson>(path.join(dir, "package.json"));
    if (pkg?.name && !index.has(pkg.name)) index.set(pkg.name, dir);
  }
  return index;
}

// Every directory in the repo that holds a `package.json`, root first
// (`findNestedFiles` skips the root's own file, and skips `node_modules`,
// `dist` and the other build/vendor directories). Used to decide which
// package a path in the output belongs to.
function collectPackageDirs(repoPath: string): string[] {
  const dirs = [path.resolve(repoPath)];
  for (const relative of findNestedFiles(repoPath, "package.json", 3)) {
    dirs.push(path.resolve(repoPath, path.dirname(relative)));
  }
  return dirs;
}

interface FailingUnit {
  /** Directory whose build precondition decides this unit. */
  pkgDir: string;
  /** Workspace name, when the failure could be attributed to one. */
  workspaceName?: string;
  /** The output attributed to this unit (one workspace segment, or all of it). */
  segment: string;
}

// The units a failing `npm test` is judged by: one per workspace that npm
// reported as failed, or a single root-package unit when the output carries no
// workspace attribution at all (a single-package repo, a non-npm runner, or a
// fan-out whose lifecycle envelope this does not recognize).
function resolveFailingUnits(repoPath: string, output: string, rootPkg: PackageJson | undefined): FailingUnit[] {
  const rootUnit: FailingUnit[] = [{ pkgDir: repoPath, segment: output }];

  const segments = splitWorkspaceSegments(output, rootPkg);
  if (!segments) return rootUnit;

  const failing = segments.filter((segment) => WORKSPACE_LIFECYCLE_FAILURE_PATTERN.test(segment));
  if (failing.length === 0) return rootUnit;

  const dirIndex = buildPackageDirIndex(repoPath);
  return failing.map((segment) => {
    const name = workspaceNameFromSegment(segment);
    const dir = name ? dirIndex.get(name) : undefined;
    return dir ? { pkgDir: dir, workspaceName: name, segment } : { pkgDir: repoPath, segment };
  });
}

const MAX_EVIDENCE_LENGTH = 160;

function clampEvidence(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_EVIDENCE_LENGTH
    ? `${trimmed.slice(0, MAX_EVIDENCE_LENGTH - 3)}...`
    : trimmed;
}

// Path-shaped tokens on one line of runner output: an absolute POSIX path, a
// Windows drive path, a `file://` URL, or a `./` / `../` relative specifier.
// A BARE specifier is deliberately not a token -- neither `lodash` nor
// `dist/index.js`: Node resolves both through `node_modules`, so they name a
// dependency rather than this package's own build output. Everything the
// corroboration reads goes through here, so no rule downstream can ever be
// satisfied by a substring that is not a path.
const PATH_TOKEN_PATTERN = /(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\s'"`,;()[\]<>]*/g;

// Decoration a path picks up in real output: a `file://` scheme, a stack
// frame's `:line:col` suffix, and sentence punctuation after the path.
function cleanPathToken(raw: string): string {
  return raw
    .replace(/^file:\/\//, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/[.,;:'"`]+$/, "");
}

// In observation mode there is no artifact to anchor to, so the whole package
// is the acceptance region and a line has to earn its way in by actually
// REPORTING a missing file. Without this, an ordinary assertion failure's own
// stack frame (which of course points inside the failing package) would be
// quoted as "the output reports a missing module".
const MISSING_FILE_REPORT_PATTERN = /Cannot find (?:module|package)|ENOENT|MODULE_NOT_FOUND/i;

function extractPathTokens(line: string): string[] {
  return (line.match(PATH_TOKEN_PATTERN) ?? [])
    .map(cleanPathToken)
    .filter((token) => token.length > 0);
}

// Resolves one token to an absolute path, or returns undefined when the token
// is not resolvable against a directory (a bare specifier).
function resolvePathToken(token: string, pkgDir: string): string | undefined {
  const normalized = token.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return path.resolve(normalized);
  }
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return path.resolve(pkgDir, normalized);
  }
  return undefined;
}

// Resolves symlinks in the longest existing prefix of a path and keeps the
// missing tail. Needed because the two sides being compared come from
// different places: the repo path as the caller spelled it, and a path a test
// runner printed from inside the process (already canonical). On macOS a
// temporary checkout under `/var/folders/...` is printed back as
// `/private/var/folders/...`, and without this every absolute token from such
// a repo would read as "outside the repo".
function canonicalizePath(target: string, cache: Map<string, string>): string {
  const cached = cache.get(target);
  if (cached) return cached;

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    resolved = parent === target ? target : path.join(canonicalizePath(parent, cache), path.basename(target));
  }
  cache.set(target, resolved);
  return resolved;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function containsNodeModulesSegment(absPath: string): boolean {
  return absPath.replace(/\\/g, "/").split("/").includes("node_modules");
}

// The package a path belongs to: the LONGEST package directory containing it.
// Longest, not first, because packages nest (every workspace sits inside the
// root package), and the innermost one is the owner.
function nearestPackageDir(target: string, packageDirs: string[]): string | undefined {
  let best: string | undefined;
  for (const dir of packageDirs) {
    if (target === dir || isInside(dir, target)) {
      if (best === undefined || dir.length > best.length) best = dir;
    }
  }
  return best;
}

// Where a corroborating path is allowed to point: the missing artifact itself,
// or anything inside the build-output directory that artifact identifies.
interface ArtifactAnchor {
  /** Absolute paths that ARE the missing artifact (including Node's resolution candidates). */
  exact: string[];
  /** Absolute build-output directory, when the artifact identifies one. */
  region?: string;
}

// Derives the anchor from ONE declared artifact, package-relative as declared:
//
// - `dist/index.js` (a file): the file itself, and its directory `dist/` as
//   the region -- a package that is not built is missing everything in there,
//   so a sibling of the declared entry point (`dist/cli.js`) corroborates.
// - `dist` / a tsconfig `outDir` (no extension): the directory itself is the
//   region, and Node's extension candidates cover the other reading of an
//   extensionless declaration (`main: "./dist/index"`).
//
// A region that is not strictly BELOW the package directory is dropped, so an
// artifact declared at the package root (`main: "index.js"`) corroborates by
// exact match only instead of accepting every path in the package.
function artifactAnchor(pkgDir: string, missingArtifact: string): ArtifactAnchor {
  const artifactAbs = path.resolve(pkgDir, missingArtifact);
  const exact = [artifactAbs];
  let region: string | undefined;

  if (path.extname(artifactAbs).length > 0) {
    region = path.dirname(artifactAbs);
  } else {
    region = artifactAbs;
    for (const extension of ARTIFACT_RESOLUTION_EXTENSIONS) exact.push(artifactAbs + extension);
    exact.push(path.join(artifactAbs, "index.js"));
  }

  return { exact, region: region && isInside(pkgDir, region) ? region : undefined };
}

function matchesArtifactAnchor(resolved: string, anchor: ArtifactAnchor): boolean {
  if (anchor.exact.includes(resolved)) return true;
  return anchor.region !== undefined && isInside(anchor.region, resolved);
}

interface CorroborationContext {
  repoPath: string;
  pkgDir: string;
  packageDirs: string[];
  anchor: ArtifactAnchor;
}

// The one path rule both corroboration shapes go through (a package's own
// guard message and Node's own module-resolution failure both just put a path
// on a line). Each condition is necessary:
//
// - no `node_modules` segment: a path resolved through `node_modules` names a
//   dependency, which a build of THIS repo does not produce;
// - inside the repository: an absolute path from somewhere else on the machine
//   says nothing about this checkout;
// - owned by the failing package: another workspace's artifact is that
//   workspace's problem, not evidence about this one;
// - anchored to the missing artifact: the path is the artifact, or lies in the
//   build-output directory the artifact identifies.
function isCorroboratingPath(resolved: string, context: CorroborationContext): boolean {
  if (containsNodeModulesSegment(resolved)) return false;
  if (!isInside(context.repoPath, resolved)) return false;
  if (nearestPackageDir(resolved, context.packageDirs) !== context.pkgDir) return false;
  return matchesArtifactAnchor(resolved, context.anchor);
}

// Text corroboration, never the decision (see the block comment above): does
// this failing unit's own output actually blame the missing artifact?
//
// Every path-shaped token on every line is resolved against the failing
// package's own directory and then tested by `isCorroboratingPath`. That
// covers both shapes the reported friction produces -- a package's own guard
// printing "<abs>/dist/index.js is missing. Run `npm run build` first" with no
// error prefix at all, and Node's own `Cannot find module './dist/index.js'` /
// `ENOENT ... open '<path>'`, whose quoted specifier is just another token on
// the line -- without either of them ever being decided by a substring.
//
// Two modes:
//   - `missingArtifact` set (the only mode a downgrade is ever decided in):
//     the path must be anchored to that artifact;
//   - `missingArtifact` absent: MESSAGE ONLY, used to quote what an otherwise
//     blocking failure observed. The path must still belong to the failing
//     package and stay out of `node_modules`, but any path inside that package
//     is quotable -- so here the LINE must additionally be a missing-file
//     report, or an ordinary assertion failure's own stack frame would be
//     quoted as one.
//
// A relative specifier is resolved against the package directory, not against
// the file that raised it, because the raising file is not in the output. A
// test in a nested directory (`test/unit.js` requiring `../dist/index.js`)
// therefore resolves outside the package and does not corroborate: the check
// stays a blocking `fail`, the safe direction.
//
// Returns the matched line, clamped, for the message.
export function findMissingArtifactEvidence(
  output: string | undefined,
  options: { repoPath: string; pkgDir?: string; missingArtifact?: string; packageDirs?: string[] }
): string | undefined {
  if (!output) return undefined;

  const cache = new Map<string, string>();
  const repoPath = canonicalizePath(path.resolve(options.repoPath), cache);
  const pkgDir = canonicalizePath(path.resolve(options.pkgDir ?? options.repoPath), cache);
  const packageDirs = (options.packageDirs ?? collectPackageDirs(options.repoPath))
    .map((dir) => canonicalizePath(path.resolve(dir), cache))
    .concat(repoPath, pkgDir);
  const anchor = options.missingArtifact
    ? artifactAnchor(pkgDir, options.missingArtifact)
    : { exact: [], region: pkgDir };
  const context: CorroborationContext = { repoPath, pkgDir, packageDirs, anchor };
  const accepts = (token: string): boolean => {
    const resolved = resolvePathToken(token, pkgDir);
    return resolved !== undefined && isCorroboratingPath(canonicalizePath(resolved, cache), context);
  };

  const isCandidateLine = (line: string): boolean =>
    options.missingArtifact !== undefined || MISSING_FILE_REPORT_PATTERN.test(line);

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || !isCandidateLine(line)) continue;
    if (extractPathTokens(line).some(accepts)) return clampEvidence(line);
  }

  return undefined;
}

export interface BuildRequiredEvaluation {
  /** True when the failing test check may be downgraded to the named skip. */
  downgrade: boolean;
  /** What made this a build-required skip, for the message. Only set when downgrading. */
  cause?: string;
  /** Workspaces the failure was attributed to, when it could be. */
  workspaceNames?: string[];
  /**
   * One sentence appended to the check's message: why this is still a blocker
   * (when not downgrading), or what else the operator should know about the
   * skip (a `--setup` build that timed out).
   */
  note?: string;
}

function logSuffix(logPath: string | undefined): string {
  return logPath ? ` (see ${logPath})` : "";
}

// Decides whether a FAILED default `npm test` check is the named
// build-required skip. See the block comment at the top of this section for
// the two conditions and why each one is necessary.
export function evaluateBuildRequiredTestFailure(options: {
  repoPath: string;
  output?: string;
  setupBuildOutcome?: SetupBuildOutcome;
}): BuildRequiredEvaluation {
  const { repoPath, output, setupBuildOutcome } = options;

  // `--setup` already tried to build this repo, so its outcome is known and
  // decides before the precondition is consulted:
  // - non-zero exit: the repo genuinely does not build right now, so a
  //   downstream missing-artifact failure is a real break, not "not built
  //   yet". Blocker naming the exit code and the persisted build log.
  // - success: the build ran to completion, so whatever the tests report now
  //   is genuine. The precondition normally says so too (the artifacts exist),
  //   but this also covers a build script that exits 0 without producing them.
  // - timeout: the build did not answer, so nothing was learned about the
  //   repo. Falls through to the normal evaluation and stays "not evaluated",
  //   the same direction every other did-not-answer path in this project takes.
  if (setupBuildOutcome?.attempted && !setupBuildOutcome.succeeded && !setupBuildOutcome.timedOut) {
    return {
      downgrade: false,
      note:
        "the `--setup` build step (`npm run build`) failed" +
        ` (exit code ${setupBuildOutcome.exitCode})${logSuffix(setupBuildOutcome.logPath)}`,
    };
  }
  if (setupBuildOutcome?.attempted && setupBuildOutcome.succeeded) {
    return {
      downgrade: false,
      note: "the `--setup` build step (`npm run build`) completed successfully, so this is not a missing build",
    };
  }

  const rootPkg = readJsonFile<PackageJson>(path.join(repoPath, "package.json"));
  const units = resolveFailingUnits(repoPath, output ?? "", rootPkg);
  const packageDirs = collectPackageDirs(repoPath);

  // The corroboration is only ever asked the decision question -- "is THIS
  // failure about THAT missing artifact" -- so it is called with the artifact
  // the precondition found, and not called at all when there is none.
  const evaluated = units.map((unit) => {
    const precondition = evaluateBuildPrecondition(unit.pkgDir);
    const evidence = precondition.met
      ? findMissingArtifactEvidence(unit.segment, {
          repoPath,
          pkgDir: unit.pkgDir,
          missingArtifact: precondition.missingArtifact,
          packageDirs,
        })
      : undefined;
    return { unit, precondition, evidence };
  });

  const blocking = evaluated.find((entry) => !entry.precondition.met || !entry.evidence);
  if (blocking) {
    return { downgrade: false, note: describeBlockingUnit(blocking, repoPath, packageDirs) };
  }

  const first = evaluated[0];
  const artifact = path.relative(
    repoPath,
    path.resolve(first.unit.pkgDir, first.precondition.missingArtifact ?? DEFAULT_BUILD_OUTPUT_DIR)
  );
  const others =
    evaluated.length > 1
      ? `, and ${evaluated.length - 1} other failing workspace${evaluated.length > 2 ? "s are" : " is"} in the same state`
      : "";
  const workspaceNames = evaluated
    .map((entry) => entry.unit.workspaceName)
    .filter((name): name is string => Boolean(name));

  return {
    downgrade: true,
    cause: `a declared build artifact (${artifact}) is missing${others}; the test output reports: ${first.evidence}`,
    workspaceNames: workspaceNames.length > 0 ? workspaceNames : undefined,
    note: setupBuildOutcome?.timedOut
      ? "the `--setup` build step (`npm run build`) timed out, so the build was not evaluated either" +
        logSuffix(setupBuildOutcome.logPath)
      : undefined,
  };
}

// Explains why a failing unit blocks instead of downgrading -- but only when
// its output actually mentions a missing artifact, so an ordinary failing
// suite keeps its plain "npm test failed" message.
function describeBlockingUnit(
  entry: { unit: FailingUnit; precondition: BuildPreconditionResult; evidence?: string },
  repoPath: string,
  packageDirs: string[]
): string | undefined {
  const where = entry.unit.workspaceName ? `workspace \`${entry.unit.workspaceName}\`` : "this repo";

  if (!entry.precondition.met) {
    // No missing artifact to anchor to (there is none, or no build script at
    // all), so this asks the message-only question instead: did this package
    // report a missing file of its own worth quoting? It cannot reach the
    // downgrade -- the precondition already decided this unit blocks.
    const observation = findMissingArtifactEvidence(entry.unit.segment, {
      repoPath,
      pkgDir: entry.unit.pkgDir,
      packageDirs,
    });
    if (!observation) return undefined;
    return entry.precondition.hasBuildScript
      ? `the output reports a missing module (${observation}), but ${where}'s declared build artifacts are all present on disk, so a build is not what is missing`
      : `the output reports a missing module (${observation}), but no \`build\` script was found for ${where}, so a build is not what is missing`;
  }

  const artifact = path.relative(
    repoPath,
    path.resolve(entry.unit.pkgDir, entry.precondition.missingArtifact ?? DEFAULT_BUILD_OUTPUT_DIR)
  );
  return `a declared build artifact (${artifact}) is missing, but the failure in ${where} does not name it, so it is reported as a real failure`;
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
// swallowed into a `limitations` string while the test check downstream is
// still reported as "build required, not yet run". `attempted` is always `true` when this
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

// Wall-clock budget for `--setup`'s own build step. A build is not a
// dependency install: it compiles the repo, so it gets the same 300 s budget
// the test check gets rather than the 120 s the other setup commands share.
// Override with `setup.buildTimeoutMs` in `.preflight.json`. A build that
// exhausts the budget is reported as "not evaluated" (see
// `evaluateBuildRequiredTestFailure`), never as a blocker.
export const DEFAULT_SETUP_BUILD_TIMEOUT_MS = 300_000;

export interface ProjectSetupOptions {
  /** Overrides `DEFAULT_SETUP_BUILD_TIMEOUT_MS` for the `--setup` build step. */
  buildTimeoutMs?: number;
}

export async function ensureProjectSetup(
  repoPath: string,
  logDir?: string,
  options?: ProjectSetupOptions
): Promise<ProjectSetupResult> {
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
  // `buildOutcome` and returned so `evaluateBuildRequiredTestFailure` can
  // tell three states apart: the build failed (a real, newly-observed break
  // -- blocking fail, never a skip), the build succeeded (whatever the tests
  // report now is genuine), and the build timed out (nothing was learned, so
  // the test check stays "not evaluated"). Full stdout+stderr is captured
  // (`all: true` inside `runSetupCommand`) and persisted the same way
  // `runShellCheck` persists a failing check's output, so the actual build
  // error is reachable even though this path never produces its own
  // `CheckResult`.
  const buildTimeoutMs = options?.buildTimeoutMs ?? DEFAULT_SETUP_BUILD_TIMEOUT_MS;
  if (hasNodeProject(context) && context.packageJson?.scripts?.build && ciShowsBuildBeforeTest(repoPath)) {
    const result = await runSetupCommand(repoPath, "npm run build", buildTimeoutMs);
    if (result.exitCode === 127) {
      limitations.push("package.json has a build script but npm is not available; --setup build step skipped");
    } else if (result.timedOut) {
      const logPath = result.output ? persistFailureOutput(logDir, "npm-run-build-setup", result.output) : undefined;
      limitations.push(
        `npm run build timed out after ${buildTimeoutMs} ms while preparing the test check (--setup)` +
        `${logPath ? ` (see ${logPath})` : ""}`
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

// `timeoutMs` defaults to the shared 120 s dependency-install budget; the
// `--setup` build step passes its own (see DEFAULT_SETUP_BUILD_TIMEOUT_MS).
async function runSetupCommand(
  repoPath: string,
  command: string,
  timeoutMs: number = 120_000
): Promise<SetupCommandResult> {
  const { exitCode, all, timedOut } = await execa(
    "bash",
    ["-c", command],
    {
      cwd: repoPath,
      reject: false,
      all: true,
      timeout: timeoutMs,
      env: buildCommandEnv(repoPath),
    }
  );

  return { exitCode: exitCode ?? 1, timedOut: Boolean(timedOut), output: all };
}
