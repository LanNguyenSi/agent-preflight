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

  it("calls execa with act --dryrun --json in the repo cwd", async () => {
    const dir = makeRepoWithWorkflows();
    mockExeca.mockResolvedValue({ exitCode: 0, all: "" });

    await runCiSimulation(dir, ["--platform", "ubuntu-latest=some/image"]);

    expect(mockExeca).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExeca.mock.calls[0];
    expect(cmd).toBe("act");
    expect(args).toContain("--dryrun");
    expect(args).toContain("--json");
    expect(args).toContain("--platform");
    expect(opts.cwd).toBe(dir);
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
