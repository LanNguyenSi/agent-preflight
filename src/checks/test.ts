import { CheckResult, PreflightConfig } from "../types.js";
import {
  CheckSetResult,
  classifyBuildRequiredFailure,
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

    const result = await runConfiguredCommands(repoPath, "test", safeCommands, 0.2, config.logDir);
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
          missingLimitation: "npm script `test` invokes a tool that is not installed; Node test check skipped",
          treatToolNotFoundAsLimitation: true,
          timeoutMs: 300_000,
          logDir: config.logDir,
        });
        if (result.check) {
          // Decision (c) (see README's "Build-required test classification"
          // and CHANGELOG): a `npm test` failure whose captured output
          // names a missing `dist/` artifact is a distinct, named outcome
          // -- `skip` with the remedy in the message -- not a blocker,
          // because it means the workspace's own test enforces a build
          // precondition preflight has not met, not that the code under
          // test is actually broken. Scoped to this default-detected
          // `npm run test` check only: a configured `commands.test`
          // override (the branch at the top of this function) is not
          // classified. Only ever downgrades a `fail`; `classifyBuildRequiredFailure`
          // requires concrete evidence (see its own comment), so a genuine
          // failure is never reclassified.
          const classification =
            result.check.status === "fail" ? classifyBuildRequiredFailure(result.rawOutput) : { matched: false };
          if (classification.matched) {
            const cause = classification.cause ?? "dist/ appears to be missing";
            const remedy =
              "run `npm run build` first (or rerun preflight with `--setup`, which builds automatically when this repo's CI shows build-before-test)";
            checks.push({
              ...result.check,
              status: "skip",
              message: `npm test not evaluated: build required before test (${cause}); ${remedy}`,
            });
            limitations.push(`npm test skipped: build required before test (${cause}); ${remedy}`);
          } else {
            checks.push(result.check);
          }
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
        logDir: config.logDir,
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
        missingLimitation: "composer script `test` invokes a tool that is not installed; PHP test check skipped",
        treatToolNotFoundAsLimitation: true,
        timeoutMs: 300_000,
        logDir: config.logDir,
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
        logDir: config.logDir,
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
    limitations.push("No supported test command found; test check skipped");
  }

  return { checks, limitations: [...new Set(limitations)] };
}
