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
  status: "pass" | "fail" | "warn" | "skip";
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

export interface PreflightConfig {
  checks?: {
    gitState?: boolean;
    lint?: boolean;
    typecheck?: boolean;
    test?: boolean;
    audit?: boolean;
    ciSimulation?: boolean;
    commitConvention?: boolean;
    secretDetection?: boolean;
    tdd?: boolean;
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
