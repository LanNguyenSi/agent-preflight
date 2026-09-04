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

// npm's own `error.code` values for a LOCAL failure of the audit command
// itself: a usage or filesystem problem that a perfectly healthy registry
// would not have changed. This is the ONLY list this check enumerates,
// because it is the only side of the split that is actually enumerable --
// these codes are npm's own stable, documented usage errors.
//
// The other side deliberately has no list. npm's registry-failure output
// carries no `error.code` at all (the reason lives in a top-level
// `message`, with `error.summary`/`error.detail` empty), and its exact
// shape varies with the transport failure and with the npm version, so any
// enumeration of it is a guess that silently misclassifies whatever it
// failed to anticipate. Hence the default direction: a non-zero exit
// without a parsed report means the audit did not answer (`skip`), and
// only a code in this list turns that into a `warn` naming a local
// failure.
const LOCAL_USAGE_ERROR_CODES = [
  "ENOLOCK",
  "EUSAGE",
  "EAUDITNOPJSON",
  "EAUDITNOLOCK",
  "ENOAUDIT",
  "EJSONPARSE",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
];

// Substrings that identify WHICH stderr line describes why the audit did
// not answer. These only ever pick human-readable cause text, never the
// outcome: by the time they are consulted the `skip` decision has already
// been made from the exit code and the absence of a report (see
// classifyAuditResult step 4b). A marker appearing in a report body, in an
// unrelated warning, or nowhere at all therefore cannot change any status.
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

// Cause strings are embedded in a check message and a limitation entry, so
// a multi-line or very long npm message is reduced to one readable line.
const MAX_CAUSE_LENGTH = 160;

function clampCause(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > MAX_CAUSE_LENGTH ? `${line.slice(0, MAX_CAUSE_LENGTH - 3)}...` : line;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Severity counts come straight out of npm's JSON, so a missing or
// non-numeric value must not leak into the `critical + high` arithmetic
// (a stringy count would concatenate rather than add, turning "0" + "0"
// into a truthy blocking count).
function vulnerabilityCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

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
  return nonEmptyString(envelope.summary) ?? nonEmptyString(envelope.code) ?? "unknown error";
}

// Best available human-readable reason for an audit that did not answer,
// in descending order of usefulness. npm's real registry failures put the
// reason in the top-level `message` ("request to <url> failed, reason:
// connect ECONNREFUSED ...", "503 Service Unavailable - POST <url> ..."),
// so that is tried first; the envelope's own summary/code covers payloads
// that carry one; a marker-bearing stderr line covers a run that printed
// no JSON at all; and the exit code is the last resort so the cause is
// never empty.
function unavailableCauseText(params: {
  payloadMessage: string | undefined;
  errorEnvelope: ErrorEnvelope | undefined;
  stderr: string;
  exitCode: number | undefined;
}): string {
  const { payloadMessage, errorEnvelope, stderr, exitCode } = params;

  const fromPayload =
    payloadMessage ??
    (errorEnvelope !== undefined
      ? nonEmptyString(errorEnvelope.summary) ?? nonEmptyString(errorEnvelope.code)
      : undefined);
  if (fromPayload !== undefined) {
    return clampCause(fromPayload);
  }

  const markerLine = stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => UNAVAILABLE_TEXT_MARKERS.some((marker) => line.includes(marker)));
  if (markerLine !== undefined && markerLine.length > 0) {
    return clampCause(markerLine);
  }

  // execa leaves `exitCode` undefined when the child was killed by a
  // signal without a timeout being recorded; naming that explicitly beats
  // printing "exit code undefined".
  return exitCode === undefined ? "exit code unknown" : `exit code ${exitCode}`;
}

interface AuditClassification {
  status: "pass" | "fail" | "warn" | "skip";
  message?: string;
  // Set only when status is "skip"; the reason the audit is reported as
  // not evaluated.
  unavailableCause?: string;
}

// Classification order (each step only runs if the previous one did not
// already decide the outcome):
//   1. timedOut -> skip, unconditionally: a timeout pre-empts everything
//      else regardless of what happened to reach it.
//   2. stdout parsed to a report carrying `metadata.vulnerabilities` ->
//      the audit answered. Judge it purely on that data (pass/fail/warn)
//      and never call it unavailable, whatever stderr says.
//   3. exit 0 without such a report -> pass. Nothing here indicates a
//      problem of any kind, and npm signalled success itself.
//   4. exit non-zero (`undefined` counts as non-zero) without such a
//      report -> the audit did not answer. Two outcomes:
//        a. a parsed envelope whose `error.code` is one of npm's local
//           usage codes -> warn naming that local failure. The audit tool
//           refused to run; that is a real, actionable result.
//        b. anything else -> skip, "not evaluated", with a limitation.
//           This is the default direction on purpose: it covers every
//           registry-side failure without enumerating any of them, so an
//           unanticipated failure shape degrades to "we did not learn
//           anything" instead of to a fabricated finding.
function classifyAuditResult(params: {
  timedOut: boolean;
  timeoutMs: number;
  exitCode: number | undefined;
  stderr: string;
  hasVulnerabilityMetadata: boolean;
  criticalCount: number;
  highCount: number;
  errorEnvelope: ErrorEnvelope | undefined;
  payloadMessage: string | undefined;
}): AuditClassification {
  const {
    timedOut,
    timeoutMs,
    exitCode,
    stderr,
    hasVulnerabilityMetadata,
    criticalCount,
    highCount,
    errorEnvelope,
    payloadMessage,
  } = params;

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

  if (exitCode === 0) {
    return { status: "pass" };
  }

  if (errorEnvelope !== undefined) {
    const code = nonEmptyString(errorEnvelope.code);
    if (code !== undefined && LOCAL_USAGE_ERROR_CODES.includes(code)) {
      return { status: "warn", message: `npm audit failed: ${envelopeCauseText(errorEnvelope)}` };
    }
  }

  return {
    status: "skip",
    unavailableCause: unavailableCauseText({ payloadMessage, errorEnvelope, stderr, exitCode }),
  };
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
      let errorEnvelope: ErrorEnvelope | undefined;
      // npm's failure payloads put the human-readable reason in a
      // TOP-LEVEL `message` (not inside `error`), which is where the cause
      // text for an unreachable or failing registry comes from.
      let payloadMessage: string | undefined;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.metadata?.vulnerabilities != null) {
          hasVulnerabilityMetadata = true;
          criticalCount = vulnerabilityCount(parsed.metadata.vulnerabilities.critical);
          highCount = vulnerabilityCount(parsed.metadata.vulnerabilities.high);
        } else if (parsed !== null && typeof parsed === "object") {
          if (parsed.error !== undefined && parsed.error !== null && typeof parsed.error === "object") {
            errorEnvelope = parsed.error as ErrorEnvelope;
          }
          payloadMessage = nonEmptyString(parsed.message);
        }
      } catch {
        // No JSON on stdout at all. Not a decision by itself: the
        // classifier still judges on the exit code, and only falls back to
        // stderr text for the cause.
      }

      const classification = classifyAuditResult({
        timedOut,
        timeoutMs: npmAuditRunner.timeoutMs,
        exitCode,
        stderr,
        hasVulnerabilityMetadata,
        criticalCount,
        highCount,
        errorEnvelope,
        payloadMessage,
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
