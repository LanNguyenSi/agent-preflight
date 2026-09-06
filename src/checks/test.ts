import { CheckResult, PreflightConfig } from "../types.js";
import {
  CheckSetResult,
  classifyBuildRequiredTestFailure,
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
  SetupBuildOutcome,
  ProjectContext,
} from "./shared.js";

// Decides the remedy text named in a build-required skip's message (round-2
// review MEDIUM-2: the prior unconditional message named `npm run build`
// and `--setup` even for a repo with no root `build` script -- two dead
// ends. `--setup`'s build step (see `ensureProjectSetup`) only ever runs
// `npm run build` at the repo root, so it can only help when the root
// `package.json` actually has that script:
// - Root has a `build` script: name it, and `--setup` (unchanged from
//   before this fix).
// - Root has none, but the classifier could attribute the failure to
//   specific workspace(s) (an npm-workspaces monorepo): name a
//   workspace-scoped build instead, since `--setup` cannot help here.
//   Exactly one workspace gets `-w <name>` (precise); more than one falls
//   back to `--workspaces --if-present` (naming every failing workspace
//   would make the message unwieldy, and `--if-present` is a safe no-op
//   for any workspace that has no `build` script of its own).
// - Root has none and no workspace could be identified (a single-package
//   repo with no `build` script at all): there is nothing to suggest
//   running; say so plainly instead of naming a command that would not
//   exist.
function buildRequiredRemedy(context: ProjectContext, workspaceNames: string[] | undefined): string {
  if (context.packageJson?.scripts?.build) {
    return "run `npm run build` first (or rerun preflight with `--setup`, which builds automatically when this repo's CI shows build-before-test)";
  }

  const rootHasNoBuildScript =
    "this repo's root `package.json` has no `build` script, so `--setup` cannot build it automatically";

  if (workspaceNames && workspaceNames.length === 1) {
    return `run \`npm run build -w ${workspaceNames[0]}\` first (${rootHasNoBuildScript})`;
  }
  if (workspaceNames && workspaceNames.length > 1) {
    return `run \`npm run build --workspaces --if-present\` first (${rootHasNoBuildScript})`;
  }

  return "no `build` script was found to produce the missing artifact; this check was not evaluated";
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
          if (result.check.status === "fail" && setupBuildOutcome?.attempted && !setupBuildOutcome.succeeded) {
            // Round-2 review HIGH-2: `--setup` itself just tried to build
            // this repo and did not succeed (non-zero exit or timeout) --
            // see `ensureProjectSetup`'s "Option (a)" block in shared.ts.
            // A subsequent test failure whose output happens to name a
            // missing `dist/` artifact is NOT "just not built yet" here;
            // the repo genuinely does not build right now, which is a real
            // regression, not the innocuous case this feature exists to
            // unblock. Never reclassify to skip in this state -- keep the
            // blocking `fail` and name the build failure so the remedy
            // points at the actual problem instead of suggesting the very
            // step that just failed.
            const reason = setupBuildOutcome.timedOut
              ? "the `--setup` build step (`npm run build`) timed out"
              : `the \`--setup\` build step (\`npm run build\`) failed (exit code ${setupBuildOutcome.exitCode})`;
            const logSuffix = setupBuildOutcome.logPath ? ` (see ${setupBuildOutcome.logPath})` : "";
            checks.push({
              ...result.check,
              message: `${result.check.message ?? "npm test failed"}: ${reason}${logSuffix}`,
            });
          } else {
            // Decision (c) (see README's "Build-required test classification"
            // and CHANGELOG): a `npm test` failure whose captured output
            // names a missing `dist/` artifact is a distinct, named outcome
            // -- `skip` with the remedy in the message -- not a blocker,
            // because it means the workspace's own test enforces a build
            // precondition preflight has not met, not that the code under
            // test is actually broken. Scoped to this default-detected
            // `npm run test` check only: a configured `commands.test`
            // override (the branch at the top of this function) is not
            // classified. Only ever downgrades a `fail`;
            // `classifyBuildRequiredTestFailure` requires concrete evidence
            // in EVERY workspace that actually failed (see its own
            // comment), so a genuine failure -- alone, or alongside an
            // unrelated build-required workspace in the same monorepo --
            // is never reclassified.
            const classification =
              result.check.status === "fail"
                ? classifyBuildRequiredTestFailure(result.rawOutput, repoPath)
                : { matched: false as const };
            if (classification.matched) {
              const cause = classification.cause ?? "dist/ appears to be missing";
              const remedy = buildRequiredRemedy(context, classification.workspaceNames);
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
