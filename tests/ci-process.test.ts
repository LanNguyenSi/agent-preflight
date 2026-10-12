/**
 * Process-level tests for runCiSimulation(): a real stub `act` on PATH, no
 * execa mock. Covers the timeout killing act's descendants and a missing act
 * binary being reported as a limitation.
 */
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createParentDeathGuard, runCiSimulation } from "../src/checks/ci.js";

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

type ProcessState = "running" | "zombie" | "gone";

/**
 * Whether a process has terminated and is only waiting to be reaped. A
 * terminated process whose parent is gone stays in the process table until
 * init reaps it, and `kill(pid, 0)` still succeeds for it. On a machine whose
 * init reaps late (or never, like a container whose pid 1 is not an init) that
 * made a stopped process look alive.
 */
function isZombie(pid: number): boolean {
  try {
    // The state follows the parenthesised command name, which may itself
    // contain spaces and parentheses.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state === "Z" || state === "X";
  } catch {
    if (fs.existsSync("/proc/self/stat")) return true; // procfs is there, the process is not
  }
  return isZombieViaPs(pid);
}

/**
 * The `ps` fallback for machines without procfs. Fails closed: only a `ps`
 * that ran and listed no such process (exit status 1, empty output) means the
 * process is gone; a `ps` that cannot run at all throws, so a broken probe
 * cannot make a live process look terminated.
 */
function isZombieViaPs(pid: number, psPath = "/bin/ps"): boolean {
  try {
    return execFileSync(psPath, ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string };
    if (failure.status === 1 && !String(failure.stdout ?? "").trim()) return true; // ps found no such process
    throw err;
  }
}

function processState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
  } catch {
    return "gone";
  }
  return isZombie(pid) ? "zombie" : "running";
}

/** True while the process can still run; a terminated process awaiting its reaper is not alive. */
function isAlive(pid: number): boolean {
  return processState(pid) === "running";
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

describe("process liveness helper", () => {
  it("fails closed when ps cannot run instead of reporting the process as gone", () => {
    expect(() => isZombieViaPs(process.pid, path.join(os.tmpdir(), "preflight-no-such-ps"))).toThrow();
  });

  it("reports a live process as not a zombie through ps", () => {
    expect(isZombieViaPs(process.pid)).toBe(false);
  });

  it("does not count a terminated process that nobody has reaped as alive", async () => {
    // The shell starts a short-lived background child and replaces itself with
    // a sleeper, which never waits on it: the child ends as a zombie that
    // stays in the process table while its parent runs.
    const holder = spawn("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const out = await new Promise<string>((resolve) => {
        holder.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      });
      const zombiePid = Number(out.trim());
      expect(zombiePid).toBeGreaterThan(0);
      expect(await waitFor(() => processState(zombiePid) !== "running", 5000)).toBe(true);
      // kill(pid, 0) alone cannot tell this process from a live one.
      expect(() => process.kill(zombiePid, 0)).not.toThrow();
      expect(processState(zombiePid)).toBe("zombie");
      expect(isAlive(zombiePid)).toBe(false);
      expect(isAlive(holder.pid as number)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  }, 15_000);
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
  // the ".js" specifiers of the sources to their ".ts" files. A timer keeps the
  // process alive after the check settles, so a signal ends it only when the
  // check's hook re-raises that signal, and "exit" and "listener" end it only
  // when the test creates the go file. It creates the ready file once the
  // check has installed its hooks.
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
const [mode, goFile, markerFile, readyFile, unboundSignal] = process.argv.slice(5);
if (mode === "listener") {
  // The host handles SIGTERM itself, so the check must not re-raise it: one
  // "x" per delivery, and a re-raise would deliver the signal a second time.
  process.on("SIGTERM", () => fs.appendFileSync(markerFile, "x"));
}
const options = { timeoutMs: 120000 };
if (mode === "unbound") {
  // Holds the check between spawning act and binding its hooks to act until
  // the signal has been delivered. The check's own handler is registered
  // before this listener, so it has seen the signal when this one runs.
  options.afterSpawn = () => new Promise((resolve) => process.once(unboundSignal, resolve));
}
runCiSimulation(process.argv[4], [], options).then(() => {});
// The call has started act and installed its termination hooks by now, since
// both happen before the first await. The test signals this process only after
// it sees this file; a signal that arrived earlier would meet no hook and end
// the process with act still running.
fs.writeFileSync(readyFile, "");
setInterval(() => {
  if (mode !== "wait" && fs.existsSync(goFile)) process.exit(3);
}, 20);
`;

  interface ParentEnd {
    code: number | null;
    signal: NodeJS.Signals | null;
  }

  type Scenario =
    | { mode: "wait"; signal: NodeJS.Signals }
    | { mode: "unbound"; signal: NodeJS.Signals }
    | { mode: "exit" }
    | { mode: "listener"; signal: "SIGTERM" };

  /** Runs the harness against a stub act, ends it as directed, and returns how it ended. */
  async function runScenario(scenario: Scenario): Promise<ParentEnd & { listenerCalls: number }> {
    const binDir = makeTempDir("preflight-ci-bin-");
    const actPidFile = path.join(binDir, "act.pid");
    const childPidFile = path.join(binDir, "child.pid");
    const goFile = path.join(binDir, "go");
    const markerFile = path.join(binDir, "listener.ran");
    const readyFile = path.join(binDir, "ready");
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
      [harnessFile, tsNode, ciSource, makeRepo(), scenario.mode, goFile, markerFile, readyFile, scenario.mode === "unbound" ? scenario.signal : ""],
      { env: { ...process.env, PATH: `${binDir}${path.delimiter}${originalPath}` }, stdio: "ignore" }
    );
    const parentEnd = new Promise<ParentEnd | null>((resolve) => {
      parent.once("exit", (code, signal) => resolve({ code, signal }));
      // A parent that is still alive after the bound did not end as it should.
      setTimeout(() => resolve(null), 10_000).unref();
    });
    try {
      expect(
        await waitFor(() => fs.existsSync(readyFile) && readPid(actPidFile) > 0 && readPid(childPidFile) > 0, 15_000),
        "act did not start, or the parent did not signal that its hooks are installed"
      ).toBe(true);
      const actPid = readPid(actPidFile);
      const childPid = readPid(childPidFile);
      expect(isAlive(actPid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);

      if (scenario.mode === "exit") {
        fs.writeFileSync(goFile, "");
      } else {
        parent.kill(scenario.signal);
        if (scenario.mode === "listener") {
          expect(await waitFor(() => fs.existsSync(markerFile), 5000)).toBe(true);
        }
      }
      if (scenario.mode === "listener") {
        // The check's hook has handled the signal without ending the host.
        const stopped = await waitFor(() => !isAlive(actPid) && !isAlive(childPid), 5000);
        expect(
          stopped,
          `act ${actPid} is ${processState(actPid)}, its sleeper ${childPid} is ${processState(childPid)}`
        ).toBe(true);
        expect(parent.exitCode === null && parent.signalCode === null).toBe(true);
        fs.writeFileSync(goFile, "");
      }

      const end = await parentEnd;
      expect(end, "the parent did not end").not.toBeNull();
      const gone = await waitFor(() => !isAlive(actPid) && !isAlive(childPid), 5000);
      expect(
        gone,
        `act ${actPid} is ${processState(actPid)}, its sleeper ${childPid} is ${processState(childPid)}; the parent ended as ${JSON.stringify(end)}`
      ).toBe(true);
      const marker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8") : "";
      return { ...(end as ParentEnd), listenerCalls: marker.length };
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    }
  }

  it.each<NodeJS.Signals>(["SIGTERM", "SIGINT", "SIGHUP"])(
    "stops act and its descendants and still dies by %s when the parent receives it",
    async (signal) => {
      const end = await runScenario({ mode: "wait", signal });
      expect(end.signal).toBe(signal);
      expect(end.code).toBeNull();
    },
    30_000
  );

  it.each<NodeJS.Signals>(["SIGTERM", "SIGINT", "SIGHUP"])(
    "stops act and its descendants and still dies by %s when it arrives before the hooks are bound to act",
    async (signal) => {
      // The harness holds the check right after act was spawned, with act's
      // pid not yet known to the hooks. Hooks registered only after the spawn
      // would not exist at this point.
      const end = await runScenario({ mode: "unbound", signal });
      expect(end.signal).toBe(signal);
      expect(end.code).toBeNull();
    },
    30_000
  );

  it("stops act and its descendants when the parent exits normally while act runs", async () => {
    const end = await runScenario({ mode: "exit" });
    expect(end).toMatchObject({ code: 3, signal: null });
  }, 30_000);

  it("stops act's group but leaves the host alive when the host has its own SIGTERM listener", async () => {
    const end = await runScenario({ mode: "listener", signal: "SIGTERM" });
    expect(end).toMatchObject({ code: 3, signal: null, listenerCalls: 1 });
  }, 30_000);
});

describe("parent-death guard", () => {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const events = ["exit", ...signals];
  let saved: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

  // The test runner may listen for these signals itself, which would count as
  // "another listener" for the re-raise decision; set them aside.
  beforeEach(() => {
    saved = new Map();
    for (const name of signals) {
      saved.set(name, process.listeners(name));
      process.removeAllListeners(name);
    }
  });
  afterEach(() => {
    for (const name of signals) {
      process.removeAllListeners(name);
      for (const l of saved.get(name) ?? []) process.on(name, l);
    }
  });

  function listenerCounts(): Record<string, number> {
    return Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
  }

  it.each(signals)("remembers %s that arrives before bind and acts on it at bind", (signal) => {
    const raised: string[] = [];
    const killed: string[] = [];
    const guard = createParentDeathGuard((s) => raised.push(s));
    process.emit(signal);
    expect(killed).toEqual([]);
    expect(raised).toEqual([]);
    guard.bind(() => killed.push("group"));
    expect(killed).toEqual(["group"]);
    expect(raised).toEqual([signal]);
    expect(process.listenerCount(signal)).toBe(0);
  });

  it("does not re-raise a remembered signal when the host listens for it itself", () => {
    const raised: string[] = [];
    const killed: string[] = [];
    const guard = createParentDeathGuard((s) => raised.push(s));
    process.emit("SIGTERM");
    const hostListener = (): void => {};
    process.on("SIGTERM", hostListener);
    guard.bind(() => killed.push("group"));
    process.removeListener("SIGTERM", hostListener);
    expect(killed).toEqual(["group"]);
    expect(raised).toEqual([]);
  });

  it("acts on a signal that arrives after bind without waiting for another call", () => {
    const raised: string[] = [];
    const killed: string[] = [];
    const guard = createParentDeathGuard((s) => raised.push(s));
    guard.bind(() => killed.push("group"));
    process.emit("SIGHUP");
    expect(killed).toEqual(["group"]);
    expect(raised).toEqual(["SIGHUP"]);
    guard.dispose();
  });

  it("ignores signals after dispose and a bind after dispose", () => {
    const raised: string[] = [];
    const killed: string[] = [];
    const before = listenerCounts();
    const guard = createParentDeathGuard((s) => raised.push(s));
    guard.dispose();
    guard.dispose();
    guard.bind(() => killed.push("group"));
    process.emit("SIGINT");
    expect(killed).toEqual([]);
    expect(raised).toEqual([]);
    expect(listenerCounts()).toEqual(before);
  });

  it("leaves no listeners behind across repeated runs", async () => {
    const binDir = makeTempDir("preflight-ci-bin-");
    fs.writeFileSync(path.join(binDir, "act"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
    const before = listenerCounts();
    for (let i = 0; i < 3; i++) {
      const result = await runCiSimulation(makeRepo(), [], { timeoutMs: 15_000 });
      expect(result.checks[0].status).toBe("pass");
      expect(listenerCounts()).toEqual(before);
    }
    process.env.PATH = makeTempDir("preflight-ci-empty-");
    await runCiSimulation(makeRepo());
    expect(listenerCounts()).toEqual(before);
  }, 30_000);
});
