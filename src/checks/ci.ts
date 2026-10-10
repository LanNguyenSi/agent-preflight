import { execa } from "execa";
import fs from "fs";
import path from "path";
import os from "os";
import { CheckResult } from "../types.js";
import { findUnsafeActFlag } from "./actFlags.js";

const ACT_NOT_INSTALLED = "act not installed; CI simulation skipped (install: https://github.com/nektos/act)";

function killProcessGroup(subprocess: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (subprocess.pid === undefined) return;
  try {
    // A negative pid signals the whole process group created by `detached`.
    process.kill(-subprocess.pid, "SIGKILL");
  } catch {
    try { subprocess.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

const ACT_TIMEOUT_MS = 120_000;

export interface CiSimulationOptions {
  /** Wall-clock limit for the act run; tests inject a short one. */
  timeoutMs?: number;
}

export async function runCiSimulation(
  repoPath: string,
  actFlags: string[] = [],
  options: CiSimulationOptions = {}
): Promise<CheckSetResult> {
  const timeoutMs = options.timeoutMs ?? ACT_TIMEOUT_MS;
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
  let timer: NodeJS.Timeout | undefined;
  try {
    // act starts its own children (job containers, shells). execa's `timeout`
    // signals only the direct child, so descendants outlive it. act runs as the
    // leader of its own process group instead, and the timeout kills the whole
    // group.
    const subprocess = execa(
      "act",
      ["--dryrun", "--json", ...actFlags, "-C", repoDir],
      { cwd: neutralDir, reject: false, all: true, detached: true }
    );
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(subprocess);
    }, timeoutMs);
    const result = await subprocess;
    const { exitCode, all } = result;

    // With `reject: false` a missing binary is a resolved result carrying the
    // spawn error code, not a rejection.
    if ((result as { code?: string }).code === "ENOENT") {
      return {
        checks: [],
        limitations: [ACT_NOT_INSTALLED],
      };
    }

    return {
      checks: [{
        name: "act-dry-run",
        kind: "ci-simulation",
        status: exitCode === 0 ? "pass" : "fail",
        message: timedOut
          ? `act dry-run timed out after ${timeoutMs} ms`
          : exitCode !== 0 ? "act dry-run detected issues" : undefined,
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
        limitations: [ACT_NOT_INSTALLED],
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
    if (timer !== undefined) clearTimeout(timer);
    fs.rmSync(neutralDir, { recursive: true, force: true });
  }
}
