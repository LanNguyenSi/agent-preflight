import { execa } from "execa";
import { CheckResult } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

const CONVENTIONAL_PATTERN = /^(feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert)(\(.+\))?: .+/;

export async function runCommitConventionCheck(repoPath: string, convention?: string): Promise<CheckSetResult> {
  if (convention === "none") {
    return { checks: [], limitations: ["commit convention check disabled in config"] };
  }

  const start = Date.now();
  const limitations: string[] = [];

  try {
    const { stdout } = await execa("git", ["log", "--oneline", "-10", "--format=%s"], { cwd: repoPath });
    const commits = stdout.split("\n").filter(Boolean);

    if (commits.length === 0) {
      return { checks: [], limitations: ["no commits found; commit convention check skipped"] };
    }

    const violations = commits.filter(msg => !CONVENTIONAL_PATTERN.test(msg));

    return {
      checks: [{
        name: "commit-convention",
        kind: "commit-convention",
        status: violations.length === 0 ? "pass" : "warn",
        message: violations.length > 0 ? `${violations.length} recent commit(s) don't follow conventional format` : undefined,
        details: violations.slice(0, 3),
        durationMs: Date.now() - start,
        confidenceContribution: 0.05,
      }],
      limitations,
    };
  } catch {
    return { checks: [], limitations: ["git not available; commit convention check skipped"] };
  }
}
