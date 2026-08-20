import fs from "fs";
import os from "os";
import path from "path";
import { CheckKind, CheckResult, CheckToggle, PreflightConfig, PreflightResult } from "./types.js";
import { ensureProjectSetup, getWorkingDirHint } from "./checks/shared.js";

// Expands a leading `~/` in a configured path to `os.homedir()`, the way a
// shell would, before the absolute/relative resolution below runs. Without
// this, `logDir: "~/logs"` was resolved as the literal relative path
// `<repoPath>/~/logs` (a directory named `~` inside the repo) instead of
// under the user's home directory, because `path.isAbsolute("~/logs")` is
// false. Only the leading-`~/` shape is handled (the common case for a
// directory value); a bare `~` with no trailing segment is left as-is.
function expandLeadingTilde(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

// Maps a CheckResult's `kind` back to the `.preflight.json` `checks.<key>`
// toggle that controls it, for the acknowledge feature below. Deliberately
// excludes:
//   - "ci-simulation" (its toggle stays a plain boolean — see
//     PreflightConfig.checks — acknowledging it is out of scope);
//   - "custom" (customChecks[] already has its own per-check `failOnError`
//     waiver);
//   - "secret-detection" (Orchestrator decision D-013, fix-round on
//     agent-tasks b31065cc): unlike every other check kind here, a single
//     `checks.secretDetection.acknowledge` reason would waive EVERY future
//     secret-detection finding for the whole run, not just the one the
//     operator actually reviewed — the scanner already has finding-scoped
//     waivers (`secretAllowlist` path/`path:line` entries, an inline
//     `pragma: allowlist secret` comment) that don't carry that blast
//     radius, so this feature intentionally does not add a coarser one.
//     See checkSecretDetectionAcknowledgeIgnored() below, which reports a
//     configured-but-inert `checks.secretDetection.acknowledge` instead of
//     silently doing nothing with it.
const CHECK_KIND_TO_CONFIG_KEY: Partial<
  Record<CheckKind, keyof NonNullable<PreflightConfig["checks"]>>
> = {
  "git-state": "gitState",
  lint: "lint",
  typecheck: "typecheck",
  test: "test",
  audit: "audit",
  "commit-convention": "commitConvention",
  tdd: "tdd",
};

interface AcknowledgeResolution {
  /** Trimmed, non-empty justification, or `null` when none was configured. */
  reason: string | null;
  /**
   * `true` when the config carried an `acknowledge` key but its value was
   * not a usable justification (missing/empty/non-string) — a config error
   * to surface, not a silent acknowledgement.
   */
  rejected: boolean;
}

// config.ts#validateConfig() does validate .preflight.json's outer shape
// (task 850903cb): it already guarantees `toggle` is a boolean or a plain
// object, dropping (with a warning) anything else before it ever reaches
// here. This function still reads the toggle defensively rather than
// trusting that outer guarantee for the INNER `acknowledge` value: any
// shape other than a plain object with a non-empty string `acknowledge` is
// treated as "no acknowledge configured" (booleans, `null`, arrays, `{}`)
// or "rejected" (an `acknowledge` key present but not a usable string),
// never a crash. Deliberately: validateConfig() only checks the toggle is
// boolean-or-object, not that an object's `acknowledge` (if present) is a
// non-empty string; that inner check, and its own `limitations` reporting
// on rejection, is intentionally kept here rather than duplicated in
// config.ts (see config.ts's CHECK_TOGGLE_KEYS comment).
function resolveAcknowledge(toggle: CheckToggle | undefined): AcknowledgeResolution {
  if (toggle === null || typeof toggle !== "object" || Array.isArray(toggle)) {
    return { reason: null, rejected: false };
  }
  if (!("acknowledge" in toggle)) {
    return { reason: null, rejected: false };
  }
  const raw = (toggle as Record<string, unknown>).acknowledge;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return { reason: raw.trim(), rejected: false };
  }
  return { reason: null, rejected: true };
}

/**
 * Downgrades a `fail` CheckResult to a non-blocking `acknowledged` status
 * when its check kind's `.preflight.json` toggle carries a valid
 * `acknowledge` justification (agent-tasks b31065cc). Scoped to `fail`
 * only — `pass`/`warn`/`skip` are already non-blocking, so there is nothing
 * to acknowledge. Never silent: every application appends a
 * `PreflightResult.limitations` entry naming the check and the reason, and
 * the check's own `message` is rewritten to carry the reason too (visible
 * in both `--json` and the human CLI output). A malformed `acknowledge`
 * (present but not a non-empty string) is rejected — the check is left
 * exactly as-is (still blocking if it failed) and a limitations entry
 * reports the rejection, so a typo'd config can never silently waive a
 * real failure. The rejection is reported once per config key (not once
 * per CheckResult) — a config key like `test` can back several results
 * (one per `commands.test` entry), and reporting the same rejection once
 * per result only differed by an internal check name, which the
 * deduplication at the end of `runPreflight` (`[...new Set(limitations)]`)
 * could not collapse (review finding, fix-round on agent-tasks b31065cc).
 */
function applyAcknowledgements(
  checks: CheckResult[],
  config: PreflightConfig
): { checks: CheckResult[]; limitations: string[] } {
  const limitations: string[] = [];
  const rejectedConfigKeys = new Set<string>();
  const transformed = checks.map((check): CheckResult => {
    const configKey = CHECK_KIND_TO_CONFIG_KEY[check.kind];
    if (!configKey) return check;

    const { reason, rejected } = resolveAcknowledge(config.checks?.[configKey]);
    if (rejected) {
      rejectedConfigKeys.add(configKey);
      return check;
    }
    if (reason && check.status === "fail") {
      limitations.push(`checks.${configKey} acknowledged (was failing "${check.name}"): ${reason}`);
      return {
        ...check,
        status: "acknowledged",
        message: check.message ? `${check.message} — acknowledged: ${reason}` : `acknowledged: ${reason}`,
      };
    }
    return check;
  });
  for (const configKey of rejectedConfigKeys) {
    limitations.push(
      `checks.${configKey}.acknowledge must be a non-empty string justification; ignoring it — checks.${configKey} is not acknowledged`
    );
  }
  return { checks: transformed, limitations };
}

/**
 * `secret-detection` has no CHECK_KIND_TO_CONFIG_KEY entry (Orchestrator
 * decision D-013, see the block comment on that map), so
 * applyAcknowledgements() above never touches it — a
 * `checks.secretDetection.acknowledge` configured in `.preflight.json` is
 * otherwise silently inert: the check still runs, still reports `fail` on
 * a real finding, and nothing ever explains why the acknowledge did
 * nothing. This reports it explicitly, once per run, whenever the toggle
 * is object-shaped and carries an `acknowledge` key at all (valid or not —
 * unlike `resolveAcknowledge`, there is no "correct" value here to accept),
 * so an operator who copies the acknowledge pattern from another check
 * kind gets a visible `limitations` entry naming the actually-supported,
 * finding-scoped alternative instead of assuming a real secret got waived
 * when it did not.
 */
function checkSecretDetectionAcknowledgeIgnored(config: PreflightConfig): string[] {
  const toggle = config.checks?.secretDetection as unknown;
  if (toggle === null || typeof toggle !== "object" || Array.isArray(toggle)) return [];
  if (!("acknowledge" in (toggle as Record<string, unknown>))) return [];
  return [
    "checks.secretDetection.acknowledge is not supported: secret-detection findings cannot be waived by check kind (a single reason would blind every future scan, not just the one finding it was meant to cover). Use secretAllowlist with a path or path:line entry, or an inline `pragma: allowlist secret` comment, to suppress one reviewed finding instead.",
  ];
}

export async function runPreflight(
  repoPath: string,
  config: PreflightConfig
): Promise<PreflightResult> {
  const start = Date.now();
  const checks: CheckResult[] = [];
  const { targetPath, limitations } = resolveTargetPath(repoPath, config.workingDir);
  if (config.setup?.enabled === true) {
    limitations.push(...await ensureProjectSetup(targetPath));
  }

  // `logDir` is resolved against `repoPath` (not `targetPath`/`workingDir`,
  // and not `process.cwd()`) so a monorepo's `workingDir` override doesn't
  // also relocate the failure-log directory, and callers running preflight
  // from a different cwd than the repo (e.g. `runBatch`) still get a
  // predictable, repo-relative location for a relative `logDir`.
  const configuredLogDir = config.logDir ? expandLeadingTilde(config.logDir) : undefined;
  const effectiveConfig: PreflightConfig = configuredLogDir
    ? { ...config, logDir: path.isAbsolute(configuredLogDir) ? configuredLogDir : path.resolve(repoPath, configuredLogDir) }
    : config;

  // Import check runners dynamically to keep dependencies optional
  const { runLintChecks } = await import("./checks/lint.js");
  const { runTypecheckChecks } = await import("./checks/typecheck.js");
  const { runTestChecks } = await import("./checks/test.js");
  const { runAuditChecks } = await import("./checks/audit.js");
  const { runSecretDetection } = await import("./checks/secrets.js");
  const { runCommitConventionCheck } = await import("./checks/commits.js");
  const { runCiSimulation } = await import("./checks/ci.js");
  const { runCustomChecks } = await import("./checks/custom.js");
  const { runGitStateChecks } = await import("./checks/git.js");

  if (config.checks?.gitState !== false) {
    const result = await runGitStateChecks(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.lint !== false) {
    const result = await runLintChecks(targetPath, effectiveConfig);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.typecheck !== false) {
    const result = await runTypecheckChecks(targetPath, effectiveConfig);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.test !== false) {
    const result = await runTestChecks(targetPath, effectiveConfig);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.audit !== false) {
    const result = await runAuditChecks(targetPath, effectiveConfig);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.secretDetection !== false) {
    const result = await runSecretDetection(targetPath, config);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }
  limitations.push(...checkSecretDetectionAcknowledgeIgnored(config));

  if (config.checks?.commitConvention !== false) {
    const result = await runCommitConventionCheck(targetPath, config.commitConvention);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  if (config.checks?.tdd !== false) {
    const { runTddCheck } = await import("./checks/tdd.js");
    const result = await runTddCheck(targetPath, config);
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
    const result = await runCustomChecks(targetPath, effectiveConfig);
    checks.push(...result.checks);
    limitations.push(...result.limitations);
  }

  // Acknowledge pass: downgrades a `fail` to non-blocking `acknowledged`
  // when the operator waived that check kind in .preflight.json with a
  // justification. Runs after every check kind above has reported in, and
  // before blockers/confidence are computed, so an acknowledged check never
  // reaches `blockers` and its status/message reflect the waiver in both
  // `checks` and the `--json` output.
  const acknowledgeResult = applyAcknowledgements(checks, config);
  const finalChecks = acknowledgeResult.checks;
  limitations.push(...acknowledgeResult.limitations);

  const blockers = finalChecks
    .filter((c) => c.status === "fail")
    .map((c) => c.message ?? c.name);

  const warnings = finalChecks
    .filter((c) => c.status === "warn")
    .map((c) => c.message ?? c.name);

  const confidence = computeConfidence(finalChecks, limitations);
  // ready = no blockers (warnings are ok); confidence is separate signal for agents
  const ready = blockers.length === 0;

  return {
    ready,
    confidence,
    checks: finalChecks,
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

  const base = passedWeight / totalWeight;

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
