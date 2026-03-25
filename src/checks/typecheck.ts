import { execa } from "execa";
import fs from "fs";
import path from "path";
import { CheckResult } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

export async function runTypecheckChecks(repoPath: string): Promise<CheckSetResult> {
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  if (fs.existsSync(path.join(repoPath, "tsconfig.json"))) {
    const start = Date.now();
    try {
      const { exitCode, stderr } = await execa("npx", ["tsc", "--noEmit", "--skipLibCheck"], { cwd: repoPath, reject: false });
      checks.push({
        name: "tsc",
        kind: "typecheck",
        status: exitCode === 0 ? "pass" : "fail",
        message: exitCode !== 0 ? "TypeScript type errors found" : undefined,
        details: exitCode !== 0 ? stderr.split("\n").slice(0, 10) : undefined,
        durationMs: Date.now() - start,
        confidenceContribution: 0.2,
      });
    } catch {
      limitations.push("tsc not available; TypeScript check skipped");
    }
  } else {
    limitations.push("No tsconfig.json found; TypeScript check skipped");
  }

  return { checks, limitations };
}
