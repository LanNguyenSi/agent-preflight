import { execa } from "execa";
import fs from "fs";
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
  weight: number
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
}

interface ShellCheckRunResult {
  check?: CheckResult;
  limitation?: string;
}

export async function runShellCheck(options: ShellCheckOptions): Promise<ShellCheckRunResult> {
  const start = Date.now();

  try {
    const { exitCode, all } = await execa(
      "bash",
      ["-lc", options.command],
      {
        cwd: options.repoPath,
        reject: false,
        all: true,
        timeout: options.timeoutMs ?? 120_000,
      }
    );

    if (exitCode === 127 && options.missingLimitation) {
      return {
        limitation: options.missingLimitation,
      };
    }

    return {
      check: {
        name: options.name,
        kind: options.kind,
        status: exitCode === 0 ? "pass" : options.failureStatus ?? "fail",
        message: exitCode === 0 ? undefined : options.failureMessage,
        details: exitCode === 0 ? undefined : outputLines(all),
        durationMs: Date.now() - start,
        confidenceContribution: options.weight,
      },
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
        details: outputLines(error.all),
        durationMs: Date.now() - start,
        confidenceContribution: options.weight,
      },
    };
  }
}

export async function commandExists(command: string, repoPath: string): Promise<boolean> {
  const { exitCode } = await execa(
    "bash",
    ["-lc", 'command -v "$CHECK_CMD" >/dev/null 2>&1'],
    {
      cwd: repoPath,
      reject: false,
      env: {
        ...process.env,
        CHECK_CMD: command,
      },
    }
  );

  return exitCode === 0;
}

export function fileExists(repoPath: string, relativePath: string): boolean {
  return fs.existsSync(path.join(repoPath, relativePath));
}

export async function ensureProjectSetup(repoPath: string): Promise<string[]> {
  const limitations: string[] = [];
  const context = createProjectContext(repoPath);

  if (hasPhpProject(context) && !fileExists(repoPath, "vendor")) {
    const { exitCode } = await execa(
      "bash",
      ["-lc", "composer install --no-interaction --no-progress"],
      {
        cwd: repoPath,
        reject: false,
        all: true,
        timeout: 120_000,
      }
    );

    if (exitCode === 127) {
      limitations.push("composer.json found but vendor/ is missing; composer install skipped because composer is not available");
    } else if (exitCode !== 0) {
      limitations.push("composer install failed while preparing PHP checks");
    }
  }

  return limitations;
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
