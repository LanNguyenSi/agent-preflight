import { CheckResult, PreflightConfig } from "../types.js";
import {
  CheckSetResult,
  commandExists,
  createProjectContext,
  fileExists,
  getConfiguredCommands,
  hasComposerPackage,
  hasComposerScript,
  hasJavaProject,
  hasNodeDependency,
  hasNodeProject,
  hasPhpProject,
  hasPythonProject,
  runConfiguredCommands,
  runShellCheck,
} from "./shared.js";

export async function runLintChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const configuredCommands = getConfiguredCommands(config, "lint");
  if (configuredCommands.length > 0) {
    return runConfiguredCommands(repoPath, "lint", configuredCommands, 0.15);
  }

  const context = createProjectContext(repoPath);
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (hasNodeProject(context)) {
    if (context.packageJson?.scripts?.lint) {
      const result = await runShellCheck({
        repoPath,
        name: "npm-lint",
        kind: "lint",
        command: "npm run lint",
        weight: 0.15,
        failureMessage: "npm lint failed",
      });
      if (result.check) {
        checks.push(result.check);
      }
      if (result.limitation) {
        limitations.push(result.limitation);
      }
    } else if (hasNodeDependency(context, "eslint")) {
      const result = await runShellCheck({
        repoPath,
        name: "eslint",
        kind: "lint",
        command: "npx eslint . --ext .ts,.tsx,.js,.jsx,.cjs,.mjs --format json",
        weight: 0.15,
        failureMessage: "eslint failed",
        missingLimitation: "npx not installed; Node lint check skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else if (context.hasTsconfig) {
      const result = await runShellCheck({
        repoPath,
        name: "tsc-lint-fallback",
        kind: "lint",
        command: "npx tsc --noEmit --skipLibCheck",
        weight: 0.15,
        failureMessage: "TypeScript lint fallback failed",
        missingLimitation: "tsc not available; TypeScript lint fallback skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
      if (result.limitation) {
        limitations.push(result.limitation);
      }
    } else {
      limitations.push("No supported Node lint command found (npm script or eslint)");
    }
  }

  if (hasPythonProject(context)) {
    if (await commandExists("ruff", repoPath)) {
      const result = await runShellCheck({
        repoPath,
        name: "ruff",
        kind: "lint",
        command: "ruff check .",
        weight: 0.15,
        failureMessage: "ruff failed",
        missingLimitation: "ruff not installed; Python lint check skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("ruff not installed; Python lint check skipped");
    }
  }

  if (hasPhpProject(context)) {
    if (hasComposerScript(context, "lint")) {
      const result = await runShellCheck({
        repoPath,
        name: "composer-lint",
        kind: "lint",
        command: "composer run lint",
        weight: 0.15,
        failureMessage: "composer lint failed",
        missingLimitation: "composer not installed; PHP lint check skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else if (fileExists(repoPath, "vendor/bin/pint") || hasComposerPackage(context, "laravel/pint")) {
      const result = await runShellCheck({
        repoPath,
        name: "pint",
        kind: "lint",
        command: "vendor/bin/pint --test",
        weight: 0.15,
        failureMessage: "pint failed",
        missingLimitation: "pint not installed; PHP lint check skipped",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else if (fileExists(repoPath, "vendor/bin/phpcs")) {
      const result = await runShellCheck({
        repoPath,
        name: "phpcs",
        kind: "lint",
        command: "vendor/bin/phpcs",
        weight: 0.15,
        failureMessage: "phpcs failed",
      });
      if (result.check) {
        checks.push(result.check);
      }
    } else {
      limitations.push("No supported PHP lint command found (composer script, pint, phpcs)");
    }
  }

  if (hasJavaProject(context)) {
    limitations.push("No default Java lint command detected; configure commands.lint in .preflight.json");
  }

  if (checks.length === 0) {
    limitations.push("No supported linter found; lint check skipped");
  }

  return { checks, limitations: [...new Set(limitations)] };
}
