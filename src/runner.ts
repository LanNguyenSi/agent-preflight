import fs from "fs";
import path from "path";
import { CheckResult, PreflightConfig, PreflightResult } from "./types.js";
import { ensureProjectSetup, getWorkingDirHint } from "./checks/shared.js";

export async function runPreflight(
  repoPath: string,
  config: PreflightConfig
): Promise<PreflightResult> {
  const start = Date.now();
  const checks: CheckResult[] = [];
  const { targetPath, limitations } = resolveTargetPath(repoPath, config.workingDir);
  limitations.push(...await ensureProjectSetup(targetPath));

  // Import check runners dynamically to keep dependencies optional
  const { runLintChecks } = await import("./checks/lint.js");
  const { runTypecheckChecks } = await import("./checks/typecheck.js");
  const { runTestChecks } = await import("./checks/test.js");
  const { runAuditChecks } = await import("./checks/audit.js");
  const { runSecretDetection } = await import("./checks/secrets.js");
  const { runCommitConventionCheck } = await import("./checks/commits.js");
  const { runCiSimulation } = await import("./checks/ci.js");
  const { runCustomChecks } = await import("./checks/custom.js");

  if (config.checks?.lint !== false) {
    const result = await runLintChecks(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.typecheck !== false) {
    const result = await runTypecheckChecks(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.test !== false) {
    const result = await runTestChecks(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.audit !== false) {
    const result = await runAuditChecks(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.secretDetection !== false) {
    const result = await runSecretDetection(targetPath);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.commitConvention !== false) {
    const result = await runCommitConventionCheck(targetPath, config.commitConvention);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.ciSimulation === true) {
    const result = await runCiSimulation(targetPath, config.actFlags ?? []);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  } else {
    limitations.push("CI simulation skipped (enable with checks.ciSimulation: true, requires act)");
  }

  if ((config.customChecks ?? []).length > 0) {
    const result = await runCustomChecks(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  const blockers = checks
    .filter((c) => c.status === "fail")
    .map((c) => c.message ?? c.name);

  const warnings = checks
    .filter((c) => c.status === "warn")
    .map((c) => c.message ?? c.name);

  const confidence = computeConfidence(checks, limitations);
  // ready = no blockers (warnings are ok); confidence is separate signal for agents
  const ready = blockers.length === 0;

  return {
    ready,
    confidence,
    checks,
    blockers,
    warnings,
    limitations: [...new Set(limitations)],
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

function computeConfidence(checks: CheckResult[], limitations: string[]): number {
  if (checks.length === 0) return 0;

  const totalWeight = checks.reduce((sum, c) => sum + c.confidenceContribution, 0);
  if (totalWeight === 0) return 0;

  const passedWeight = checks
    .filter((c) => c.status === "pass")
    .reduce((sum, c) => sum + c.confidenceContribution, 0);

  let base = passedWeight / totalWeight;

  // Deduct for each limitation (they represent unknown territory)
  const limitationPenalty = Math.min(limitations.length * 0.03, 0.2);
  return Math.max(0, Math.min(1, base - limitationPenalty));
}

function resolveTargetPath(repoPath: string, workingDir?: string): { targetPath: string; limitations: string[] } {
  if (!workingDir || workingDir === ".") {
    const suggestedWorkingDir = getWorkingDirHint(repoPath);
    const limitations = suggestedWorkingDir
      ? [`package.json found in ${suggestedWorkingDir}/ - set workingDir: ${suggestedWorkingDir} in .preflight.json`]
      : [];
    return { targetPath: repoPath, limitations };
  }

  try {
    const targetPath = path.resolve(repoPath, workingDir);
    if (!fs.existsSync(targetPath)) {
      return {
        targetPath: repoPath,
        limitations: [`workingDir "${workingDir}" not found; using repository root instead`],
      };
    }

    return {
      targetPath,
      limitations: [],
    };
  } catch {
    return {
      targetPath: repoPath,
      limitations: [`Invalid workingDir "${workingDir}"; using repository root instead`],
    };
  }
}
