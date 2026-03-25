import { CheckResult, PreflightConfig, PreflightResult } from "./types.js";

export async function runPreflight(
  repoPath: string,
  config: PreflightConfig
): Promise<PreflightResult> {
  const start = Date.now();
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  // Import check runners dynamically to keep dependencies optional
  const { runLintChecks } = await import("./checks/lint.js");
  const { runTypecheckChecks } = await import("./checks/typecheck.js");
  const { runAuditChecks } = await import("./checks/audit.js");
  const { runSecretDetection } = await import("./checks/secrets.js");
  const { runCommitConventionCheck } = await import("./checks/commits.js");
  const { runCiSimulation } = await import("./checks/ci.js");

  if (config.checks?.lint !== false) {
    const result = await runLintChecks(repoPath);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.typecheck !== false) {
    const result = await runTypecheckChecks(repoPath);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.audit !== false) {
    const result = await runAuditChecks(repoPath);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.secretDetection !== false) {
    const result = await runSecretDetection(repoPath);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.commitConvention !== false) {
    const result = await runCommitConventionCheck(repoPath, config.commitConvention);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.ciSimulation === true) {
    const result = await runCiSimulation(repoPath, config.actFlags ?? []);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  } else {
    limitations.push("CI simulation skipped (enable with checks.ciSimulation: true, requires act)");
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
