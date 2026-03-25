import { CheckResult, PreflightConfig } from "../types.js";
import {
  CheckSetResult,
  commandExists,
  createProjectContext,
  fileExists,
  getConfiguredCommands,
  hasComposerPackage,
  hasJavaProject,
  hasNodeProject,
  hasPhpProject,
  hasPythonProject,
  runConfiguredCommands,
  runShellCheck,
} from "./shared.js";

export async function runTypecheckChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const configuredCommands = getConfiguredCommands(config, "typecheck");
  if (configuredCommands.length > 0) {
    return runConfiguredCommands(repoPath, "typecheck", configuredCommands, 0.2);
  }

  const context = createProjectContext(repoPath);
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (hasNodeProject(context) && context.hasTsconfig) {
    const result = await runShellCheck({
      repoPath,
      name: "tsc",
      kind: "typecheck",
      command: "npx tsc --noEmit --skipLibCheck",
      weight: 0.2,
      failureMessage: "TypeScript type errors found",
      missingLimitation: "tsc not available; TypeScript check skipped",
    });
    if (result.check) {
      checks.push(result.check);
    }
    if (result.limitation) {
      limitations.push(result.limitation);
    }
  } else if (hasNodeProject(context)) {
    limitations.push("No tsconfig.json found; TypeScript check skipped");
  }

  if (hasPythonProject(context)) {
    if (await commandExists("mypy", repoPath)) {
      const result = await runShellCheck({
        repoPath,
        name: "mypy",
        kind: "typecheck",
        command: "mypy .",
        weight: 0.2,
        failureMessage: "mypy found type issues",
        missingLimitation: "mypy not installed; Python typecheck skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("mypy not installed; Python typecheck skipped");
    }
  }

  if (hasPhpProject(context)) {
    if (fileExists(repoPath, "vendor/bin/phpstan") || hasComposerPackage(context, "phpstan/phpstan")) {
      const result = await runShellCheck({
        repoPath,
        name: "phpstan",
        kind: "typecheck",
        command: "vendor/bin/phpstan analyse",
        weight: 0.2,
        failureMessage: "phpstan found type issues",
        missingLimitation: "phpstan not installed; PHP typecheck skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else if (fileExists(repoPath, "vendor/bin/psalm") || hasComposerPackage(context, "vimeo/psalm")) {
      const result = await runShellCheck({
        repoPath,
        name: "psalm",
        kind: "typecheck",
        command: "vendor/bin/psalm --no-progress",
        weight: 0.2,
        failureMessage: "psalm found type issues",
        missingLimitation: "psalm not installed; PHP typecheck skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("No supported PHP typecheck command found (phpstan, psalm)");
    }
  }

  if (hasJavaProject(context)) {
    const command = context.hasMavenWrapper
      ? "./mvnw -q -DskipTests compile"
      : context.hasPomXml
        ? "mvn -q -DskipTests compile"
        : context.hasGradleWrapper
          ? "./gradlew classes -q"
          : context.hasGradleBuild
            ? "gradle classes -q"
            : undefined;

    if (command) {
      const result = await runShellCheck({
        repoPath,
        name: command.includes("mvn") ? "maven-compile" : "gradle-classes",
        kind: "typecheck",
        command,
        weight: 0.2,
        failureMessage: "Java compile check failed",
        missingLimitation: "Maven/Gradle not installed; Java typecheck skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
      if (result.limitation) {
        limitations.push(result.limitation);
      }
    }
  }

  if (checks.length === 0) {
    limitations.push("No supported typecheck command found; typecheck skipped");
  }

  return { checks, limitations: [...new Set(limitations)] };
}
