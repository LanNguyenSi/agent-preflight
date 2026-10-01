import { CheckResult, PreflightConfig } from "../types.js";
import fs from "fs";
import { composerBinPath, findPhpConfig, quotePhpArgument } from "./php.js";
import {
  CheckSetResult,
  commandExists,
  createProjectContext,
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
  if (configuredCommands.error || configuredCommands.commands.length > 0) {
    return runConfiguredCommands(repoPath, "typecheck", configuredCommands, 0.2, config.logDir);
  }

  const context = createProjectContext(repoPath);
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (hasNodeProject(context) && context.packageJson?.scripts?.typecheck) {
    const result = await runShellCheck({
      repoPath,
      name: "npm-typecheck",
      kind: "typecheck",
      command: "npm run typecheck",
      weight: 0.2,
      failureMessage: "npm typecheck failed",
      missingLimitation: "npm script `typecheck` invokes a tool that is not installed; Node typecheck skipped",
      treatToolNotFoundAsLimitation: true,
      logDir: config.logDir,
    });
    if (result.check) {
      checks.push(result.check);
    }
    if (result.limitation) {
      limitations.push(result.limitation);
    }
  } else if (hasNodeProject(context) && context.hasTsconfig) {
    const result = await runShellCheck({
      repoPath,
      name: "tsc",
      kind: "typecheck",
      command: "npx tsc --noEmit --skipLibCheck",
      weight: 0.2,
      failureMessage: "TypeScript type errors found",
      missingLimitation: "tsc not available; TypeScript check skipped",
      logDir: config.logDir,
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
        logDir: config.logDir,
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("mypy not installed; Python typecheck skipped");
    }
  }

  if (hasPhpProject(context)) {
    const phpstan = composerBinPath(context, "phpstan");
    const psalm = composerBinPath(context, "psalm");
    if (fs.existsSync(phpstan) || hasComposerPackage(context, "phpstan/phpstan")) {
      const phpConfig = await findPhpConfig(repoPath, "phpstan");
      if (!phpConfig) {
        limitations.push("No PHPStan config found within the repository; configure commands.typecheck in .preflight.json");
      } else {
        const result = await runShellCheck({
          repoPath,
          name: "phpstan",
          kind: "typecheck",
          command: `${quotePhpArgument(phpstan)} analyse --configuration=${quotePhpArgument(phpConfig)}`,
          primaryCommand: phpstan,
          weight: 0.2,
          failureMessage: "phpstan found type issues",
          missingLimitation: "phpstan not installed; PHP typecheck skipped",
          logDir: config.logDir,
        });
        if (result.check) {
          checks.push(result.check);
        }
        if (result.limitation) {
          limitations.push(result.limitation);
        }
      }
    } else if (fs.existsSync(psalm) || hasComposerPackage(context, "vimeo/psalm")) {
      const result = await runShellCheck({
        repoPath,
        name: "psalm",
        kind: "typecheck",
        command: `${quotePhpArgument(psalm)} --no-progress`,
        primaryCommand: psalm,
        weight: 0.2,
        failureMessage: "psalm found type issues",
        missingLimitation: "psalm not installed; PHP typecheck skipped",
        logDir: config.logDir,
      });
      if (result.check) {
        checks.push(result.check);
      }
      if (result.limitation) {
        limitations.push(result.limitation);
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
        logDir: config.logDir,
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
