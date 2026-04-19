import { CheckResult, PreflightConfig } from "../types.js";
import {
  CheckSetResult,
  commandExists,
  createProjectContext,
  getConfiguredCommands,
  hasJavaProject,
  hasNodeProject,
  hasPhpProject,
  hasPythonProject,
  hasComposerScript,
  runConfiguredCommands,
  runShellCheck,
  fileExists,
  shouldSkipRecursiveNodeTest,
} from "./shared.js";

export async function runTestChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const configuredCommands = getConfiguredCommands(config, "test");
  if (configuredCommands.length > 0) {
    const safeCommands = configuredCommands.filter((command) => !shouldSkipRecursiveNodeTest(repoPath, command));
    const limitations = configuredCommands.length === safeCommands.length
      ? []
      : ["Skipping recursive Node test command while already running under Vitest"];

    const result = await runConfiguredCommands(repoPath, "test", safeCommands, 0.2);
    return {
      checks: result.checks,
      limitations: [...limitations, ...result.limitations],
    };
  }

  const context = createProjectContext(repoPath);
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (hasNodeProject(context)) {
    if (context.packageJson?.scripts?.test) {
      if (shouldSkipRecursiveNodeTest(repoPath, "npm run test")) {
        limitations.push("Skipping recursive Node test command while already running under Vitest");
      } else {
        const result = await runShellCheck({
          repoPath,
          name: "npm-test",
          kind: "test",
          command: "npm run test",
          weight: 0.2,
          failureMessage: "npm test failed",
          timeoutMs: 300_000,
        });
        if (result.check) {
          checks.push(result.check);
        }
        if (result.limitation) {
          limitations.push(result.limitation);
        }
      }
    } else {
      limitations.push("No Node test script found; Node test check skipped");
    }
  }

  if (hasPythonProject(context)) {
    if (await commandExists("pytest", repoPath)) {
      const result = await runShellCheck({
        repoPath,
        name: "pytest",
        kind: "test",
        command: "pytest",
        weight: 0.2,
        failureMessage: "pytest failed",
        missingLimitation: "pytest not installed; Python test check skipped",
        timeoutMs: 300_000,
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("pytest not installed; Python test check skipped");
    }
  }

  if (hasPhpProject(context)) {
    if (hasComposerScript(context, "test")) {
      const result = await runShellCheck({
        repoPath,
        name: "composer-test",
        kind: "test",
        command: "composer run test",
        weight: 0.2,
        failureMessage: "composer test failed",
        missingLimitation: "composer not installed; PHP test check skipped",
        timeoutMs: 300_000,
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else if (fileExists(repoPath, "vendor/bin/phpunit")) {
      const result = await runShellCheck({
        repoPath,
        name: "phpunit",
        kind: "test",
        command: "vendor/bin/phpunit",
        weight: 0.2,
        failureMessage: "phpunit failed",
        timeoutMs: 300_000,
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("No supported PHP test command found (composer script or phpunit)");
    }
  }

  if (hasJavaProject(context)) {
    const command = context.hasMavenWrapper
      ? "./mvnw -q test"
      : context.hasPomXml
        ? "mvn -q test"
        : context.hasGradleWrapper
          ? "./gradlew test -q"
          : context.hasGradleBuild
            ? "gradle test -q"
            : undefined;

    if (command) {
      const result = await runShellCheck({
        repoPath,
        name: command.includes("mvn") ? "maven-test" : "gradle-test",
        kind: "test",
        command,
        weight: 0.2,
        failureMessage: "Java test command failed",
        missingLimitation: "Maven/Gradle not installed; Java test check skipped",
        timeoutMs: 300_000,
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
    limitations.push("No supported test command found; test check skipped");
  }

  return { checks, limitations: [...new Set(limitations)] };
}
