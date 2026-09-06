import { CheckResult, PreflightConfig } from "../types.js";
import {
  CheckSetResult,
  evaluateBuildRequiredTestFailure,
  commandExists,
  createProjectContext,
  getConfiguredCommands,
  hasJavaProject,
  hasNodeProject,
  hasPhpProject,
  hasPythonProject,
  hasComposerScript,
  runConfiguredCommands,
  rootBuildScriptFansOutToWorkspaces,
  runShellCheck,
  fileExists,
  shouldSkipRecursiveNodeTest,
  SetupBuildOutcome,
  ProjectContext,
} from "./shared.js";

// Names what the operator should actually run to satisfy the build
// precondition that `evaluateBuildRequiredTestFailure` found unmet. Reached
// only for a downgrade, so every failing unit has a `build` script of its own
// -- the root package's, or each attributed workspace's. What the message may
// name is narrower than that, because `--setup`'s build step only ever runs
// `npm run build` at the repo ROOT:
// - the failure is the root package's: name `npm run build` and `--setup`;
// - the failures are workspaces' and the root script fans out over the
//   workspaces: the same root build reaches them, so name it too;
// - otherwise the root build would not touch them (or does not exist): name a
//   workspace-scoped build instead, and say why `--setup` cannot help.
//   Exactly one workspace gets `-w <name>` (precise); more than one falls back
//   to `--workspaces --if-present`, which builds every failing workspace here
//   since each one has its own build script.
function buildRequiredRemedy(context: ProjectContext, workspaceNames: string[] | undefined): string {
  const rootBuild = "run `npm run build` first (or rerun preflight with `--setup`, which builds automatically when this repo's CI shows build-before-test)";
  if (!workspaceNames || workspaceNames.length === 0) return rootBuild;
  if (rootBuildScriptFansOutToWorkspaces(context.packageJson)) return rootBuild;

  const whySetupCannotHelp = context.packageJson?.scripts?.build
    ? "this repo's root `build` script does not fan out over the workspaces, so `--setup` cannot build them automatically"
    : "this repo's root `package.json` has no `build` script, so `--setup` cannot build it automatically";

  if (workspaceNames.length === 1) {
    return `run \`npm run build -w ${workspaceNames[0]}\` first (${whySetupCannotHelp})`;
  }
  return `run \`npm run build --workspaces --if-present\` first (${whySetupCannotHelp})`;
}

export async function runTestChecks(
  repoPath: string,
  config: PreflightConfig,
  setupBuildOutcome?: SetupBuildOutcome
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
          // The named build-required outcome (decision (c); see README's
          // "Build-required test classification"). The decision itself lives
          // in `evaluateBuildRequiredTestFailure`: a failing `npm test` is
          // downgraded to a non-blocking `skip` only when the FILESYSTEM says
          // every failing package is unbuilt (a build script exists and a
          // declared artifact is missing) AND that package's own output
          // blames the missing artifact. A genuine failure -- alone, or
          // alongside an unbuilt package in the same monorepo -- keeps the
          // blocking `fail`. Scoped to this default-detected `npm run test`
          // check: a configured `commands.test` override (the branch at the
          // top of this function) is never classified.
          const evaluation =
            result.check.status === "fail"
              ? evaluateBuildRequiredTestFailure({
                  repoPath,
                  output: result.rawOutput,
                  setupBuildOutcome,
                })
              : undefined;

          // Set only when the classification could not be evaluated at all
          // (a corroboration call threw). The check itself stays the blocking
          // `fail` it already was; this records that the "build required?"
          // question went unanswered.
          if (evaluation?.limitation) {
            limitations.push(evaluation.limitation);
          }

          if (evaluation?.downgrade) {
            const remedy = buildRequiredRemedy(context, evaluation.workspaceNames);
            const note = evaluation.note ? `; ${evaluation.note}` : "";
            const message = `npm test not evaluated: build required before test (${evaluation.cause})${note}; ${remedy}`;
            checks.push({ ...result.check, status: "skip", message });
            limitations.push(message);
          } else if (evaluation?.note) {
            checks.push({
              ...result.check,
              message: `${result.check.message ?? "npm test failed"}: ${evaluation.note}`,
            });
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
