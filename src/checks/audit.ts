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
  // execa 8 leaves `exitCode` undefined when the child was killed by a
  // signal (e.g. the timeout below) rather than exiting normally; treated
  // as non-zero (never as success) everywhere this is compared below.
  exitCode: number | undefined;
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

// npm error-envelope `error.code` values attributable to the registry's
// advisory endpoint rather than a local/usage problem: HTTP 5xx/429 codes
// npm surfaces as `E5xx`/`E429`, and network-level errnos. A code outside
// this list (ENOLOCK, EUSAGE, EAUDITNOPJSON, an unknown code, ...) is a
// local failure and stays `warn`, never `skip`.
const REGISTRY_ERROR_CODES = [
  "E503",
  "E502",
  "E504",
  "E429",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "EPROTO",
  "ERR_SOCKET_TIMEOUT",
];

// Substrings that mark a non-zero, non-JSON npm audit result as "the
// registry's advisory endpoint could not be reached": npm's own
// endpoint-error message, or a network-level errno. Only consulted when
// there is no parseable JSON at all (see classifyAuditResult) -- a report
// that actually parsed is judged on its own vulnerability counts, and a
// parsed error envelope is judged on its `error.code`, so a marker token
// appearing inside a report body or an unrelated envelope summary never
// reaches this path.
const UNAVAILABLE_TEXT_MARKERS = [
  "audit endpoint returned an error",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "EPROTO",
  "ERR_SOCKET_TIMEOUT",
];

function timeoutCause(timeoutMs: number): string {
  return timeoutMs < 1000
    ? `timed out after ${timeoutMs}ms`
    : `timed out after ${Math.round(timeoutMs / 1000)}s`;
}

interface ErrorEnvelope {
  code?: unknown;
  summary?: unknown;
}

function envelopeCauseText(envelope: ErrorEnvelope): string {
  const summary = typeof envelope.summary === "string" && envelope.summary.length > 0 ? envelope.summary : undefined;
  const code = typeof envelope.code === "string" && envelope.code.length > 0 ? envelope.code : undefined;
  return summary ?? code ?? "unknown error";
}

interface AuditClassification {
  status: "pass" | "fail" | "warn" | "skip";
  message?: string;
  // Set only when status is "skip"; the reason the registry's advisory
  // endpoint is treated as unreachable.
  unavailableCause?: string;
}

// Classification order (each step only runs if the previous one did not
// already decide the outcome):
//   1. timedOut -> skip, unconditionally -- a timeout pre-empts everything
//      else regardless of what happened to reach it.
//   2. stdout parses to a report carrying `metadata.vulnerabilities` -> the
//      audit answered. Judge it purely on that data (today's pass/fail/warn
//      logic) and never call it unavailable, no matter what stderr says.
//   3. Otherwise, only when the exit was non-zero: a parsed JSON error
//      envelope is split by `error.code` -- a registry-attributable code is
//      `skip`, anything else (ENOLOCK, EUSAGE, an unknown code, ...) is
//      `warn` naming that local failure. With no JSON at all, look for the
//      unavailable-text markers in stderr, then stdout; a hit is `skip`, no
//      hit is today's plain `warn`.
//   4. exit 0 with unparsable/empty stdout: unchanged `pass` (nothing here
//      indicates a problem of any kind).
function classifyAuditResult(params: {
  timedOut: boolean;
  timeoutMs: number;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  hasVulnerabilityMetadata: boolean;
  criticalCount: number;
  highCount: number;
  errorEnvelope: ErrorEnvelope | undefined;
}): AuditClassification {
  const { timedOut, timeoutMs, exitCode, stdout, stderr, hasVulnerabilityMetadata, criticalCount, highCount, errorEnvelope } =
    params;

  if (timedOut) {
    return { status: "skip", unavailableCause: timeoutCause(timeoutMs) };
  }

  if (hasVulnerabilityMetadata) {
    const blockingCount = criticalCount + highCount;
    return {
      status: exitCode === 0 ? "pass" : blockingCount > 0 ? "fail" : "warn",
      message: blockingCount > 0 ? `${criticalCount} critical, ${highCount} high vulnerabilities found` : undefined,
    };
  }

  if (exitCode !== 0) {
    if (errorEnvelope !== undefined) {
      const code = typeof errorEnvelope.code === "string" ? errorEnvelope.code : undefined;
      if (code !== undefined && REGISTRY_ERROR_CODES.includes(code)) {
        return { status: "skip", unavailableCause: envelopeCauseText(errorEnvelope) };
      }
      return { status: "warn", message: `npm audit failed: ${envelopeCauseText(errorEnvelope)}` };
    }
    const marker =
      UNAVAILABLE_TEXT_MARKERS.find((m) => stderr.includes(m)) ??
      UNAVAILABLE_TEXT_MARKERS.find((m) => stdout.includes(m));
    if (marker) {
      return { status: "skip", unavailableCause: marker };
    }
    return { status: "warn" };
  }

  return { status: "pass" };
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
      let criticalCount = 0;
      let highCount = 0;
      let hasVulnerabilityMetadata = false;
      let errorEnvelope: { code?: unknown; summary?: unknown } | undefined;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.metadata?.vulnerabilities != null) {
          hasVulnerabilityMetadata = true;
          criticalCount = parsed.metadata.vulnerabilities.critical ?? 0;
          highCount = parsed.metadata.vulnerabilities.high ?? 0;
        } else if (parsed?.error !== undefined && parsed?.error !== null) {
          errorEnvelope = parsed.error;
        }
      } catch {
        // ignore parse failures and fall back to the exit-code/marker path below
      }

      const classification = classifyAuditResult({
        timedOut,
        timeoutMs: npmAuditRunner.timeoutMs,
        exitCode,
        stdout,
        stderr,
        hasVulnerabilityMetadata,
        criticalCount,
        highCount,
        errorEnvelope,
      });

      if (classification.status === "skip") {
        const cause = classification.unavailableCause ?? "unknown reason";
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
        checks.push({
          name: "npm-audit",
          kind: "audit",
          status: classification.status,
          message: classification.message,
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
