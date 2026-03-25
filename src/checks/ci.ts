import { execa } from "execa";
import fs from "fs";
import path from "path";
import { CheckResult } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

export async function runCiSimulation(repoPath: string, actFlags: string[] = []): Promise<CheckSetResult> {
  const limitations: string[] = [
    "act simulation may not match GitHub Actions exactly",
    "external services and secrets are not available in local simulation",
  ];

  const workflowDir = path.join(repoPath, ".github", "workflows");
  if (!fs.existsSync(workflowDir)) {
    return {
      checks: [],
      limitations: ["no .github/workflows found; CI simulation skipped"],
    };
  }

  const start = Date.now();
  try {
    const { exitCode, all } = await execa(
      "act",
      ["--dryrun", "--json", ...actFlags],
      { cwd: repoPath, reject: false, all: true, timeout: 120_000 }
    );

    return {
      checks: [{
        name: "act-dry-run",
        kind: "ci-simulation",
        status: exitCode === 0 ? "pass" : "fail",
        message: exitCode !== 0 ? "act dry-run detected issues" : undefined,
        details: all?.split("\n").slice(0, 10),
        durationMs: Date.now() - start,
        confidenceContribution: 0.25,
      }],
      limitations,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        checks: [],
        limitations: ["act not installed; CI simulation skipped (install: https://github.com/nektos/act)"],
      };
    }
    return {
      checks: [{
        name: "act-dry-run",
        kind: "ci-simulation",
        status: "fail",
        message: `act failed: ${(err as Error).message}`,
        durationMs: Date.now() - start,
        confidenceContribution: 0.25,
      }],
      limitations,
    };
  }
}
