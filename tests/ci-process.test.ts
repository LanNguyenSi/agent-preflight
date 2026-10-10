/**
 * Process-level tests for runCiSimulation(): a real stub `act` on PATH, no
 * execa mock. Covers the timeout killing act's descendants and a missing act
 * binary being reported as a limitation.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runCiSimulation } from "../src/checks/ci.js";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(): string {
  const dir = makeTempDir("preflight-ci-proc-");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    // Reap a stub child that a failing test left behind.
    const pidFile = path.join(dir, "child.pid");
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (pid > 0 && isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCiSimulation process behaviour", () => {
  it("leaves no act descendant alive after the timeout", async () => {
    const binDir = makeTempDir("preflight-ci-bin-");
    const pidFile = path.join(binDir, "child.pid");
    // The stub starts a long sleeper that inherits act's output pipe, records
    // its pid, then waits on it like act waits on a job container.
    fs.writeFileSync(
      path.join(binDir, "act"),
      `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\nwait\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

    const result = await runCiSimulation(makeRepo(), [], { timeoutMs: 1500 });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("timed out");
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(childPid).toBeGreaterThan(0);
    // SIGKILL delivery to the group is synchronous; allow a bounded wait for
    // the kernel to finish tearing the process down.
    const deadline = Date.now() + 3000;
    while (isAlive(childPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(isAlive(childPid)).toBe(false);
  }, 15_000);

  it("reports the not-installed limitation when act is not on PATH", async () => {
    process.env.PATH = makeTempDir("preflight-ci-empty-");

    const result = await runCiSimulation(makeRepo());

    expect(result.checks).toHaveLength(0);
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).toContain("act not installed");
  });
});
