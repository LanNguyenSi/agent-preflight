import { execa } from "execa";
import fs from "fs";
import path from "path";
import os from "os";
import { CheckResult } from "../types.js";
import { findUnsafeActFlag } from "./actFlags.js";

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

  // actFlags come from the repo config; refuse the ones that turn the dry run
  // into step execution before act is started.
  const refusal = findUnsafeActFlag(actFlags);
  if (refusal !== undefined) {
    return {
      checks: [{
        name: "act-dry-run",
        kind: "ci-simulation",
        status: "fail",
        message: refusal,
        durationMs: Date.now() - start,
        confidenceContribution: 0.25,
      }],
      limitations,
    };
  }

  // act reads an `.actrc` from the process working directory (measured with
  // act 0.2.89; `-C` does not make it read the target's). The repo's `.actrc`
  // can carry a self-hosted platform mapping, so act runs from an empty
  // directory and gets the repo through `-C`; the operator's own actrc files
  // (home and XDG config) are still read.
  const repoDir = path.resolve(repoPath);
  if (fs.existsSync(path.join(repoDir, ".actrc"))) {
    limitations.push("the repo's .actrc is not read by CI simulation (act runs from a neutral working directory)");
  }
  const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-act-"));
  try {
    const { exitCode, all } = await execa(
      "act",
      ["--dryrun", "--json", ...actFlags, "-C", repoDir],
      { cwd: neutralDir, reject: false, all: true, timeout: 120_000 }
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
  } finally {
    fs.rmSync(neutralDir, { recursive: true, force: true });
  }
}
