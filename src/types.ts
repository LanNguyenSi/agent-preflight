export interface PreflightResult {
  ready: boolean;
  confidence: number; // 0.0 - 1.0
  checks: CheckResult[];
  blockers: string[];
  warnings: string[];
  limitations: string[];
  durationMs: number;
  timestamp: string;
}

export interface CheckResult {
  name: string;
  kind: CheckKind;
  // "acknowledged": the check ran and failed, but the operator waived it in
  // .preflight.json with a required justification (checks.<kind>.acknowledge).
  // Treated like "warn": visible, but never a `ready:false` blocker. See
  // resolveAcknowledge/applyAcknowledgements in src/runner.ts.
  status: "pass" | "fail" | "warn" | "skip" | "acknowledged";
  message?: string;
  details?: string[];
  durationMs: number;
  confidenceContribution: number; // how much this check contributes to overall confidence
}

export type CheckKind =
  | "git-state"
  | "lint"
  | "typecheck"
  | "test"
  | "audit"
  | "ci-simulation"
  | "commit-convention"
  | "secret-detection"
  | "tdd"
  | "custom";

/**
 * A check's `.preflight.json` toggle. `true`/`false` enable/disable the
 * check, same as before. `{ acknowledge: "<reason>" }` runs the check as
 * normal but, if it fails, downgrades that failure to a non-blocking
 * `acknowledged` status (see CheckResult.status and
 * runner.ts#applyAcknowledgements) — the failure stays visible (its own
 * status, its message carries the reason) but no longer flips `ready` to
 * `false`. `acknowledge` is required to be a non-empty string; a missing or
 * non-string value is rejected (ignored, with the rejection reported in
 * `PreflightResult.limitations`), never silently treated as "acknowledged".
 * Deliberately NOT supported for `ciSimulation` (kept a plain boolean) or
 * `custom` checks (which already have their own per-check `failOnError`).
 */
export type CheckToggle = boolean | { acknowledge: string };

export interface PreflightConfig {
  checks?: {
    gitState?: CheckToggle;
    lint?: CheckToggle;
    typecheck?: CheckToggle;
    test?: CheckToggle;
    audit?: CheckToggle;
    ciSimulation?: boolean;
    commitConvention?: CheckToggle;
    secretDetection?: CheckToggle;
    tdd?: CheckToggle;
  };
  tddExceptions?: string[];
  /**
   * Operator-reviewed secret-detection findings to suppress. Each entry
   * is a repo-root-relative path (suppresses the whole file), a
   * `path:line` pair (suppresses one finding), or a `*`-glob matching
   * either. An inline `pragma: allowlist secret` comment on the line is
   * an alternative to listing it here.
   */
  secretAllowlist?: string[];
  /**
   * When true, every secret-detection finding in a committable file is a
   * `fail` blocker regardless of whether the current branch touched that
   * file. The default (false) is diff-scoped: a secret in a file the
   * branch did not change is reported as a non-blocking `warn`.
   */
  secretDetectionStrict?: boolean;
  protectedBranches?: string[];
  /**
   * Directory the complete stdout+stderr of a failing shell-based check
   * (lint, typecheck, test, audit, custom) is persisted to, overriding the
   * default `~/.agent-preflight/logs`. A relative path is resolved against
   * the repo root (the `repoPath` passed to `runPreflight`/`runBatch`), not
   * `workingDir` and not `process.cwd()`. Only the 20 newest of this
   * feature's own log files are kept; unrelated files in the directory are
   * left alone. See README "Configuration" for the on-disk log format.
   */
  logDir?: string;
  actFlags?: string[];
  commitConvention?: "conventional" | "none";
  workingDir?: string;
  setup?: {
    enabled?: boolean;
  };
  commands?: {
    lint?: string[];
    typecheck?: string[];
    test?: string[];
    audit?: string[];
  };
  sandbox?: SandboxConfig;
  customChecks?: CustomCheck[];
}

export interface CustomCheck {
  name: string;
  command: string;
  failOnError?: boolean;
}

export interface SandboxConfig {
  aptPackages?: string[];
  pipPackages?: string[];
}
