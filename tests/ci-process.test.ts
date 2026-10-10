/**
 * Process-level tests for runCiSimulation(): a real stub `act` on PATH, no
 * execa mock. Covers the timeout killing act's descendants and a missing act
 * binary being reported as a limitation.
 */
import { spawn } from "child_process";
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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return condition();
}

function readPid(file: string): number {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    // Reap stub processes that a failing test left behind.
    for (const name of ["child.pid", "act.pid"]) {
      const pid = readPid(path.join(dir, name));
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

  it("kills a descendant that does not hold act's output pipes", async () => {
    const binDir = makeTempDir("preflight-ci-bin-");
    const pidFile = path.join(binDir, "child.pid");
    // The sleeper's stdio is detached from act's pipes, so execa returns as
    // soon as act itself dies. Only the process-group kill can reach it; the
    // pid assertion below, not a test timeout, catches a missed kill.
    fs.writeFileSync(
      path.join(binDir, "act"),
      `#!/bin/sh\nsleep 300 </dev/null >/dev/null 2>&1 &\necho $! > "${pidFile}"\nsleep 300\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

    const result = await runCiSimulation(makeRepo(), [], { timeoutMs: 1500 });

    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("timed out");
    const childPid = readPid(pidFile);
    expect(childPid).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(childPid), 3000)).toBe(true);
  }, 15_000);

  it("returns shortly after the timeout when a descendant outside the group holds act's pipes", async () => {
    const binDir = makeTempDir("preflight-ci-bin-");
    const pidFile = path.join(binDir, "child.pid");
    // The sleeper starts its own session (detached), so the group kill cannot
    // reach it, and it inherits act's output pipes. Without a bound on the
    // stream wait the call would last as long as the sleeper (8 s).
    const script =
      'const c=require("child_process").spawn("sleep",["8"],{detached:true,stdio:["ignore","inherit","inherit"]});' +
      'require("fs").writeFileSync(process.argv[1],String(c.pid));c.unref();';
    fs.writeFileSync(
      path.join(binDir, "act"),
      `#!/bin/sh\n"${process.execPath}" -e '${script}' "${pidFile}"\nsleep 300\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

    const started = Date.now();
    const result = await runCiSimulation(makeRepo(), [], { timeoutMs: 1000 });
    const elapsed = Date.now() - started;

    expect(readPid(pidFile)).toBeGreaterThan(0);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("timed out");
    // timeoutMs + stream grace (2 s) + slack, well below the sleeper's 8 s.
    expect(elapsed).toBeLessThan(6000);
  }, 20_000);

  it("reports the not-installed limitation when act is not on PATH", async () => {
    process.env.PATH = makeTempDir("preflight-ci-empty-");

    const result = await runCiSimulation(makeRepo());

    expect(result.checks).toHaveLength(0);
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).toContain("act not installed");
  });
});

describe("runCiSimulation when preflight itself is terminated", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const ciSource = path.join(repoRoot, "src", "checks", "ci.ts");
  const tsNode = path.join(repoRoot, "node_modules", "ts-node", "dist", "index.js");

  // A parent process that runs the check against a stub act, then dies as the
  // test directs. ts-node loads the TypeScript source; the resolver hook maps
  // the ".js" specifiers of the sources to their ".ts" files.
  const harness = `
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith(".") && request.endsWith(".js")) {
    try { return orig.call(this, request.slice(0, -3) + ".ts", ...rest); } catch (e) { /* fall through */ }
  }
  return orig.call(this, request, ...rest);
};
require(process.argv[2]).register({ transpileOnly: true, compilerOptions: { module: "commonjs" } });
const { runCiSimulation } = require(process.argv[3]);
const fs = require("fs");
const exitWhenActRuns = process.argv[5] === "exit";
runCiSimulation(process.argv[4], [], { timeoutMs: 120000 }).then(() => {});
if (exitWhenActRuns) {
  const timer = setInterval(() => {
    if (fs.existsSync(process.argv[6])) process.exit(3);
  }, 20);
}
`;

  async function runScenario(end: NodeJS.Signals | "exit"): Promise<void> {
    const binDir = makeTempDir("preflight-ci-bin-");
    const actPidFile = path.join(binDir, "act.pid");
    const childPidFile = path.join(binDir, "child.pid");
    // act and a sleeper that holds act's output pipe, like a job container.
    fs.writeFileSync(
      path.join(binDir, "act"),
      `#!/bin/sh\necho $$ > "${actPidFile}"\nsleep 300 &\necho $! > "${childPidFile}"\nwait\n`,
      { mode: 0o755 }
    );
    const harnessFile = path.join(binDir, "harness.cjs");
    fs.writeFileSync(harnessFile, harness);

    const parent = spawn(
      process.execPath,
      [
        harnessFile,
        tsNode,
        ciSource,
        makeRepo(),
        end === "exit" ? "exit" : "wait",
        childPidFile,
      ],
      { env: { ...process.env, PATH: `${binDir}${path.delimiter}${originalPath}` }, stdio: "ignore" }
    );
    const parentExited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    try {
      expect(await waitFor(() => readPid(actPidFile) > 0 && readPid(childPidFile) > 0, 15_000)).toBe(true);
      const actPid = readPid(actPidFile);
      const childPid = readPid(childPidFile);
      expect(isAlive(actPid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);

      if (end !== "exit") parent.kill(end);
      await parentExited;

      expect(await waitFor(() => !isAlive(actPid) && !isAlive(childPid), 5000)).toBe(true);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    }
  }

  it.each<NodeJS.Signals>(["SIGTERM", "SIGINT"])("stops act and its descendants when the parent receives %s", async (signal) => {
    await runScenario(signal);
  }, 30_000);

  it("stops act and its descendants when the parent exits normally while act runs", async () => {
    await runScenario("exit");
  }, 30_000);
});
