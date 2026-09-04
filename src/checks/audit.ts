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

// Plain result shape read by `runAuditChecks`'s npm branch, independent of
// execa's own (larger) return type so a test can mock `npmAuditRunner.run`
// with a small literal instead of a full ExecaReturnValue.
export interface NpmAuditRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Test seam: the only way `runAuditChecks`'s npm branch reaches `npm audit`.
// tests/audit.test.ts and the beforeEach/afterEach installers in
// tests/helpers/npm-audit-mock.ts replace `run` with `vi.spyOn` so the test
// suite never depends on a live registry. Not configurable from
// `.preflight.json`; `timeoutMs` is read at call time (not captured at
// import time) so a test can lower it for a real-timeout assertion and
// restore it afterwards.
export const npmAuditRunner = {
  timeoutMs: 90_000,
  async run(repoPath: string): Promise<NpmAuditRunResult> {
    const result = await execa(
      "bash",
      ["-lc", "npm audit --json"],
      {
        cwd: repoPath,
        reject: false,
        timeout: npmAuditRunner.timeoutMs,
      }
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  },
};

// Substrings that mark a non-zero npm audit result as "the registry's
// advisory endpoint could not be reached" rather than a real audit finding:
// npm's own endpoint-error message, or a network-level errno. Matched
// against stdout and stderr combined, case-sensitively (these are all
// fixed-case npm/Node error tokens).
const UNAVAILABLE_MARKERS = [
  "audit endpoint returned an error",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "E503",
];

function unavailableCause(
  timedOut: boolean,
  timeoutMs: number,
  combinedOutput: string,
  errorEnvelope: unknown
): string | undefined {
  if (timedOut) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  const marker = UNAVAILABLE_MARKERS.find((m) => combinedOutput.includes(m));
  if (marker) {
    return marker;
  }
  if (errorEnvelope !== undefined) {
    const summary =
      typeof errorEnvelope === "object" && errorEnvelope !== null
        ? (errorEnvelope as { summary?: unknown; code?: unknown }).summary ??
          (errorEnvelope as { summary?: unknown; code?: unknown }).code
        : undefined;
    return typeof summary === "string" && summary.length > 0
      ? summary
      : "error response with no vulnerability data";
  }
  return undefined;
}

export async function runAuditChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const configuredCommands = getConfiguredCommands(config, "audit");
  if (configuredCommands.length > 0) {
    return runConfiguredCommands(repoPath, "audit", configuredCommands, 0.15, config.logDir);
  }

  const context = createProjectContext(repoPath);
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (hasNodeProject(context)) {
    if (!(await commandExists("npm", repoPath))) {
      limitations.push("npm not installed; Node audit skipped");
    } else {
      const start = Date.now();
      const { exitCode, stdout, stderr, timedOut } = await npmAuditRunner.run(repoPath);
      const combinedOutput = `${stdout}\n${stderr}`;
      let criticalCount = 0;
      let highCount = 0;
      let hasVulnerabilityMetadata = false;
      let errorEnvelope: unknown;
      try {
        const parsed = JSON.parse(stdout);
        criticalCount = parsed?.metadata?.vulnerabilities?.critical ?? 0;
        highCount = parsed?.metadata?.vulnerabilities?.high ?? 0;
        hasVulnerabilityMetadata = parsed?.metadata?.vulnerabilities != null;
        errorEnvelope = parsed?.error;
      } catch {
        // ignore parse failures and treat the command exit as the source of truth
      }

      const cause = unavailableCause(
        timedOut,
        npmAuditRunner.timeoutMs,
        combinedOutput,
        errorEnvelope !== undefined && !hasVulnerabilityMetadata ? errorEnvelope : undefined
      );

      if (cause !== undefined) {
        checks.push({
          name: "npm-audit",
          kind: "audit",
          status: "skip",
          message: `npm audit not evaluated: registry advisory endpoint unavailable (${cause})`,
          durationMs: Date.now() - start,
          confidenceContribution: 0.15,
        });
        limitations.push(`npm audit skipped: registry advisory endpoint unavailable (${cause})`);
      } else {
        const blockingCount = criticalCount + highCount;
        checks.push({
          name: "npm-audit",
          kind: "audit",
          status: exitCode === 0 ? "pass" : blockingCount > 0 ? "fail" : "warn",
          message:
            blockingCount > 0
              ? `${criticalCount} critical, ${highCount} high vulnerabilities found`
              : undefined,
          durationMs: Date.now() - start,
          confidenceContribution: 0.15,
        });
      }
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
          logDir: config.logDir,
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
      logDir: config.logDir,
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
