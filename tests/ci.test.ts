/**
 * Tests for src/checks/ci.ts — runCiSimulation()
 *
 * Covers: act invocation, exitCode pass/fail mapping, ENOENT 'act not installed'
 * fallback, generic act-failure catch, and the no-.github/workflows path.
 *
 * execa is mocked via vi.hoisted so the factory reference is stable across
 * module imports.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Stable mock reference for execa ──────────────────────────────────────────
const mockExeca = vi.hoisted(() => vi.fn());

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return { ...actual, execa: mockExeca };
});

import { runCiSimulation } from "../src/checks/ci.js";

// ── Temp dir helpers ──────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "preflight-ci-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepoWithWorkflows(extraFiles: Record<string, string> = {}): string {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
  for (const [file, content] of Object.entries(extraFiles)) {
    const fullPath = path.join(dir, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

// ── Test cases ────────────────────────────────────────────────────────────────

describe("runCiSimulation — no .github/workflows", () => {
  it("returns empty checks and a skip limitation when workflows dir is missing", async () => {
    const dir = makeTempDir();
    // No .github/workflows directory
    const result = await runCiSimulation(dir);

    expect(result.checks).toHaveLength(0);
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).toContain("CI simulation skipped");
  });
});

describe("runCiSimulation — act exits 0", () => {
  it("returns a pass check when act dry-run succeeds", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "step1\nstep2" });

    const result = await runCiSimulation(dir);

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("act-dry-run");
    expect(result.checks[0].kind).toBe("ci-simulation");
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].message).toBeUndefined();
    // Standard limitations about act simulation accuracy should always be present
    expect(result.limitations.length).toBeGreaterThan(0);
    expect(result.limitations.some((l) => l.includes("act simulation"))).toBe(true);
  });

  it("calls execa with act --dryrun --json, the repo as -C, and a neutral cwd", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    await runCiSimulation(dir, ["--platform", "ubuntu-latest=some/image"]);

    expect(mockExeca).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExeca.mock.calls[0];
    expect(cmd).toBe("act");
    expect(args.slice(0, 2)).toEqual(["--dryrun", "--json"]);
    expect(args).toContain("--platform");
    expect(args.slice(-2)).toEqual(["-C", dir]);
    // act reads .actrc from its working directory, which must not be the repo.
    expect(opts.cwd).not.toBe(dir);
    expect(fs.existsSync(opts.cwd)).toBe(false);
  });

  it("runs act from an empty directory that exists during the call and is removed afterwards", async () => {
    const dir = makeRepoWithWorkflows({ ".actrc": "-P ubuntu-latest=-self-hosted\n" });
    let seenCwd = "";
    let entriesDuringCall: string[] = [];
    mockExeca.mockImplementation(async (_cmd: string, _args: string[], opts: { cwd: string }) => {
      seenCwd = opts.cwd;
      entriesDuringCall = fs.readdirSync(opts.cwd);
      return { exitCode: 0, all: "" };
    });

    await runCiSimulation(dir);

    expect(entriesDuringCall).toEqual([]);
    expect(path.resolve(seenCwd)).not.toBe(path.resolve(dir));
    expect(fs.existsSync(seenCwd)).toBe(false);
  });

  it("reports that the repo's .actrc is not read when the file exists", async () => {
    const dir = makeRepoWithWorkflows({ ".actrc": "-P ubuntu-latest=-self-hosted\n" });
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    const result = await runCiSimulation(dir);

    expect(result.limitations.some((l) => l.includes(".actrc") && l.includes("not read"))).toBe(true);
  });

  it("does not mention .actrc when the repo has none", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    const result = await runCiSimulation(dir);

    expect(result.limitations.some((l) => l.includes(".actrc"))).toBe(false);
  });

  it("still passes a container platform mapping through to act", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    const result = await runCiSimulation(dir, ["-P", "ubuntu-22.04=node:22-slim", "--pull=false"]);

    expect(result.checks[0].status).toBe("pass");
    const [, args] = mockExeca.mock.calls[0];
    expect(args).toEqual(["--dryrun", "--json", "-P", "ubuntu-22.04=node:22-slim", "--pull=false", "-C", dir]);
  });
});

describe("runCiSimulation — refuses actFlags that execute steps", () => {
  it.each<[string, string[]]>([
    ["-P self-hosted", ["-P", "ubuntu-latest=-self-hosted"]],
    ["--platform self-hosted", ["--platform", "ubuntu-22.04=-self-hosted"]],
    ["--platform=self-hosted", ["--platform=ubuntu-22.04=-self-hosted"]],
    ["-P=self-hosted", ["-P=ubuntu-22.04=-self-hosted"]],
    ["attached -Pvalue", ["-Pubuntu-22.04=-self-hosted"]],
    ["--dryrun=false", ["--dryrun=false"]],
    ["--dryrun=0", ["--dryrun=0"]],
    ["-n=false", ["-n=false"]],
    ["-bn=false", ["-bn=false"]],
    ["the default mapping plus --dryrun=false", ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest", "--dryrun=false"]],
  ])("does not start act for %s and reports a failing check", async (_label, flags) => {
    const dir = makeRepoWithWorkflows();

    const result = await runCiSimulation(dir, flags);

    expect(mockExeca).not.toHaveBeenCalled();
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("act-dry-run");
    expect(result.checks[0].kind).toBe("ci-simulation");
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("CI simulation refused: actFlags entry");
  });

  it("names the offending flag in the blocker message", async () => {
    const dir = makeRepoWithWorkflows();

    const result = await runCiSimulation(dir, ["--pull=false", "--dryrun=false"]);

    expect(result.checks[0].message).toContain('"--dryrun=false"');
  });
});

describe("runCiSimulation — act exits non-zero", () => {
  it("returns a fail check when act dry-run exits with non-zero code", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 1, all: "some error output" });

    const result = await runCiSimulation(dir);

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toBe("act dry-run detected issues");
    expect(result.limitations.some((l) => l.includes("act simulation"))).toBe(true);
  });
});

describe("runCiSimulation — act not installed (ENOENT)", () => {
  it("returns empty checks and a limitation when act is not installed", async () => {
    const dir = makeRepoWithWorkflows();
    const enoentError = Object.assign(new Error("spawn act ENOENT"), { code: "ENOENT" });
    mockExeca.mockRejectedValue(enoentError);

    const result = await runCiSimulation(dir);

    expect(result.checks).toHaveLength(0);
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).toContain("act not installed");
    expect(result.limitations[0]).toContain("CI simulation skipped");
  });
});

describe("runCiSimulation — generic act failure", () => {
  it("returns a fail check with the error message for unexpected errors", async () => {
    const dir = makeRepoWithWorkflows();
    const genericError = new Error("timeout exceeded");
    mockExeca.mockRejectedValue(genericError);

    const result = await runCiSimulation(dir);

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("act failed");
    expect(result.checks[0].message).toContain("timeout exceeded");
  });
});

describe("runCiSimulation — confidence contribution", () => {
  it("each check carries a non-zero confidenceContribution", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    const result = await runCiSimulation(dir);

    expect(result.checks[0].confidenceContribution).toBeGreaterThan(0);
  });
});

/** A pending subprocess stand-in that `await` resolves when `finish` is called. */
function pendingSubprocess(extra: Record<string, unknown> = {}) {
  let finish!: (value: { exitCode: number; all: string }) => void;
  const promise = new Promise<{ exitCode: number; all: string }>((resolve) => {
    finish = resolve;
  });
  return { subprocess: Object.assign(promise, extra), finish };
}

describe("runCiSimulation — timers and process hooks", () => {
  it("starts act detached so the timeout can signal its whole process group", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    await runCiSimulation(dir);

    expect(mockExeca.mock.calls[0][2].detached).toBe(true);
  });

  it("leaves no timer pending and no process listener behind after a normal act exit", async () => {
    vi.useFakeTimers();
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });
    const before = {
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      sighup: process.listenerCount("SIGHUP"),
    };

    const result = await runCiSimulation(dir, [], { timeoutMs: 60_000 });

    expect(result.checks[0].status).toBe("pass");
    expect(vi.getTimerCount()).toBe(0);
    expect({
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      sighup: process.listenerCount("SIGHUP"),
    }).toEqual(before);
  });

  it("clears the timers and listeners when act fails to start", async () => {
    vi.useFakeTimers();
    const dir = makeRepoWithWorkflows();
    mockExeca.mockRejectedValue(new Error("boom"));
    const exitListeners = process.listenerCount("exit");

    await runCiSimulation(dir);

    expect(vi.getTimerCount()).toBe(0);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  it("signals act's process group with SIGKILL when the timeout fires", async () => {
    vi.useFakeTimers();
    const dir = makeRepoWithWorkflows();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { subprocess, finish } = pendingSubprocess({ pid: 4242, kill: vi.fn() });
    mockExeca.mockReturnValue(subprocess);

    const run = runCiSimulation(dir, [], { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    finish({ exitCode: 1, all: "" });
    const result = await run;

    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toBe("act dry-run timed out after 1000 ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to killing the direct child when the group kill throws", async () => {
    vi.useFakeTimers();
    const dir = makeRepoWithWorkflows();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
    });
    const directKill = vi.fn();
    const { subprocess, finish } = pendingSubprocess({ pid: 4242, kill: directKill });
    mockExeca.mockReturnValue(subprocess);

    const run = runCiSimulation(dir, [], { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(directKill).toHaveBeenCalledWith("SIGKILL");
    finish({ exitCode: 1, all: "" });
    await run;
  });

  it("destroys act's output streams a grace period after the group kill", async () => {
    vi.useFakeTimers();
    const dir = makeRepoWithWorkflows();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const stdout = { destroy: vi.fn() };
    const stderr = { destroy: vi.fn() };
    const all = { destroy: vi.fn() };
    const { subprocess, finish } = pendingSubprocess({ pid: 4242, kill: vi.fn(), stdout, stderr, all });
    mockExeca.mockReturnValue(subprocess);

    const run = runCiSimulation(dir, [], { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stdout.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(stdout.destroy).toHaveBeenCalledOnce();
    expect(stderr.destroy).toHaveBeenCalledOnce();
    expect(all.destroy).toHaveBeenCalledOnce();
    finish({ exitCode: 1, all: "" });
    await run;
  });

  it("reports a failing check when the timeout fired even though act then exited 0", async () => {
    vi.useFakeTimers();
    const dir = makeRepoWithWorkflows();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { subprocess, finish } = pendingSubprocess({ pid: 4242, kill: vi.fn() });
    mockExeca.mockReturnValue(subprocess);

    const run = runCiSimulation(dir, [], { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    finish({ exitCode: 0, all: "" });
    const result = await run;

    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("timed out");
  });
});
