import { execa } from "execa";
import fs from "fs";
import path from "path";
import { CheckResult } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

export async function runAuditChecks(repoPath: string): Promise<CheckSetResult> {
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (fs.existsSync(path.join(repoPath, "package-lock.json"))) {
    const start = Date.now();
    const { exitCode, stdout } = await execa("npm", ["audit", "--json"], { cwd: repoPath, reject: false });
    let criticalCount = 0;
    try {
      const parsed = JSON.parse(stdout);
      criticalCount = parsed?.metadata?.vulnerabilities?.critical ?? 0;
    } catch {}
    checks.push({
      name: "npm-audit",
      kind: "audit",
      status: exitCode === 0 ? "pass" : criticalCount > 0 ? "fail" : "warn",
      message: criticalCount > 0 ? `${criticalCount} critical vulnerabilities found` : undefined,
      durationMs: Date.now() - start,
      confidenceContribution: 0.15,
    });
  } else {
    limitations.push("No package-lock.json; npm audit skipped");
  }

  return { checks, limitations };
}
