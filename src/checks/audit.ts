import { execa } from "execa";
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
  runConfiguredCommands,
  runShellCheck,
} from "./shared.js";

export async function runAuditChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const configuredCommands = getConfiguredCommands(config, "audit");
  if (configuredCommands.length > 0) {
    return runConfiguredCommands(repoPath, "audit", configuredCommands, 0.15);
  }

  const context = createProjectContext(repoPath);
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (hasNodeProject(context)) {
    const start = Date.now();
    const { exitCode, stdout } = await execa(
      "bash",
      ["-lc", "npm audit --json"],
      { cwd: repoPath, reject: false }
    );
    if (exitCode === 127) {
      limitations.push("npm not installed; Node audit skipped");
    } else {
      let criticalCount = 0;
      try {
        const parsed = JSON.parse(stdout);
        criticalCount = parsed?.metadata?.vulnerabilities?.critical ?? 0;
      } catch {
        // ignore parse failures and treat the command exit as the source of truth
      }
      checks.push({
        name: "npm-audit",
        kind: "audit",
        status: exitCode === 0 ? "pass" : criticalCount > 0 ? "fail" : "warn",
        message: criticalCount > 0 ? `${criticalCount} critical vulnerabilities found` : undefined,
        durationMs: Date.now() - start,
        confidenceContribution: 0.15,
      });
    }
  }

  if (hasPythonProject(context)) {
    if (context.hasRequirementsTxt) {
      if (await commandExists("pip-audit", repoPath)) {
        const result = await runShellCheck({
          repoPath,
          name: "pip-audit",
          kind: "audit",
          command: "pip-audit -r requirements.txt",
          weight: 0.15,
          failureMessage: "pip-audit found dependency issues",
          missingLimitation: "pip-audit not installed; Python audit skipped",
          failureStatus: "warn",
        });
        if (result.check) {
          checks.push(result.check);
        }
      } else {
        limitations.push("pip-audit not installed; Python audit skipped");
      }
    } else {
      limitations.push("Python audit currently expects requirements.txt; configure commands.audit for pyproject-only repos");
    }
  }

  if (hasPhpProject(context)) {
    const result = await runShellCheck({
      repoPath,
      name: "composer-audit",
      kind: "audit",
      command: "composer audit --format=json",
      weight: 0.15,
      failureMessage: "composer audit found dependency issues",
      missingLimitation: "composer not installed; PHP audit skipped",
      failureStatus: "warn",
    });
    if (result.check) {
      checks.push(result.check);
    }
    if (result.limitation) {
      limitations.push(result.limitation);
    }
  }

  if (hasJavaProject(context)) {
    limitations.push("No default Java audit command detected; configure commands.audit in .preflight.json");
  }

  if (checks.length === 0) {
    limitations.push("No supported audit command found; audit check skipped");
  }

  return { checks, limitations: [...new Set(limitations)] };
}
