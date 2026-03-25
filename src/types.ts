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
  | "lint"
  | "typecheck"
  | "test"
  | "audit"
  | "ci-simulation"
  | "commit-convention"
  | "secret-detection"
  | "custom";

export interface PreflightConfig {
  checks?: {
    lint?: boolean;
    typecheck?: boolean;
    test?: boolean;
    audit?: boolean;
    ciSimulation?: boolean;
    commitConvention?: boolean;
    secretDetection?: boolean;
  };
  actFlags?: string[];
  commitConvention?: "conventional" | "none";
  workingDir?: string;
  commands?: {
    lint?: string[];
    typecheck?: string[];
    test?: string[];
    audit?: string[];
  };
  customChecks?: CustomCheck[];
}

export interface CustomCheck {
  name: string;
  command: string;
  failOnError?: boolean;
}
