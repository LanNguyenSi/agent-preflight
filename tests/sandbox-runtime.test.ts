/**
 * Tests for src/sandbox.ts — runSandbox() and createSandboxPlan() runtime paths.
 *
 * The pure string-builders (buildDockerRunCommand, sanitizeContainerName, etc.)
 * are already exercised in tests/sandbox.test.ts. This file focuses on:
 *  - plan assembly (field correctness, build/pull command presence)
 *  - build-vs-pull decision (autoBuild flag)
 *  - --docker-socket mounting guard
 *  - Dockerfile-missing error path (vi.spyOn fs.existsSync)
 *  - docker.sock-absent guard (vi.spyOn fs.existsSync, always exercised)
 *  - docker-socket positive mount assertion via buildDockerRunCommand
 *  - runSandbox --print mode (no docker run invocation)
 *  - runSandbox docker-absent error path
 *  - runSandbox success path (exit code propagation)
 *
 * execa is mocked via vi.hoisted. child_process.spawnSync is partially mocked
 * only in the test that needs docker to appear absent.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Stable mock references ────────────────────────────────────────────────────
const mockExeca = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn());

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return { ...actual, execa: mockExeca };
});

// child_process is a Node built-in; we do a partial mock keeping spawnSync
// replaceable per-test.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, spawnSync: mockSpawnSync };
});

import { buildDockerRunCommand, createSandboxPlan, runSandbox } from "../src/sandbox.js";

// ── Temp dir helpers ──────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "preflight-sbx-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a minimal workspace directory (no Dockerfile needed — that lives
 * in the package root, not the workspace).
 */
function makeWorkspace(): string {
  const dir = makeTempDir();
  // A bare directory is valid as a workspace; no specific files required
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

// ── Default spawnSync behaviour (docker in PATH, git unavailable for cwd) ────
//
// In CI/WSL environments docker may be in PATH but not running. We default
// mockSpawnSync so that:
//  - git calls (resolveGitRoot) fail → workspacePath falls back to explicit path
//  - docker calls (commandExists) succeed (status 0, no error) → docker "found"
//  - docker image inspect (localImageExists via execa mock) returns exitCode 1
//    → image does NOT exist, so autoBuild can fire

beforeEach(() => {
  // Default: any spawnSync call succeeds (status 0, no error)
  mockSpawnSync.mockReturnValue({ status: 0, error: undefined, stdout: "" });

  // Default: docker image inspect → image does not exist
  mockExeca.mockResolvedValue({ exitCode: 1 });
});

// ── createSandboxPlan ─────────────────────────────────────────────────────────

describe("createSandboxPlan — plan assembly", () => {
  it("returns a plan with all required fields", async () => {
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, {});

    expect(plan).toMatchObject({
      workspacePath: workspace,
      image: expect.stringContaining("agent-preflight"),
      profile: expect.objectContaining({
        capabilities: expect.any(Array),
        aptPackages: expect.any(Array),
        pipPackages: expect.any(Array),
        fingerprint: expect.any(String),
        targetPath: expect.any(String),
      }),
      runCommand: expect.arrayContaining(["docker", "run"]),
    });
  });

  it("uses the custom image when --image is provided", async () => {
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, { image: "my-custom-image:v1" });
    expect(plan.image).toBe("my-custom-image:v1");
  });

  it("sets buildCommand when --build is requested", async () => {
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, { build: true });
    expect(plan.buildCommand).toBeDefined();
    expect(plan.buildCommand).toContain("docker");
    expect(plan.buildCommand).toContain("build");
  });

  it("sets pullCommand when --pull is requested", async () => {
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, { pull: true });
    expect(plan.pullCommand).toBeDefined();
    expect(plan.pullCommand).toContain("docker");
    expect(plan.pullCommand).toContain("pull");
  });

  it("does not set buildCommand or pullCommand when neither flag is given and image exists", async () => {
    // Image exists → autoBuild is false
    mockExeca.mockResolvedValue({ exitCode: 0 }); // image inspect succeeds
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, {});
    expect(plan.buildCommand).toBeUndefined();
    expect(plan.pullCommand).toBeUndefined();
  });

  it("autoBuild is true for a local-candidate image that does not exist", async () => {
    // Image does not exist (exitCode 1) and no explicit build/pull requested
    mockExeca.mockResolvedValue({ exitCode: 1 });
    const workspace = makeWorkspace();
    // No custom image → default agent-preflight:local (a local candidate)
    const plan = await createSandboxPlan(workspace, {});
    expect(plan.autoBuild).toBe(true);
    expect(plan.buildCommand).toBeDefined();
  });

  it("autoBuild is false when a custom (non-local) image is specified", async () => {
    // Even if image doesn't exist locally, a remote image should not be auto-built
    mockExeca.mockResolvedValue({ exitCode: 1 });
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, { image: "ghcr.io/org/some-image:latest" });
    expect(plan.autoBuild).toBe(false);
    expect(plan.buildCommand).toBeUndefined();
  });

  it("runCommand excludes --docker-socket mount when dockerSocket is false", async () => {
    const workspace = makeWorkspace();
    const plan = await createSandboxPlan(workspace, { dockerSocket: false });
    expect(plan.runCommand).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("throws when Dockerfile is missing from the package root", async () => {
    const workspace = makeWorkspace();
    // Intercept fs.existsSync to return false for Dockerfile paths so the guard
    // at createSandboxPlan fires even though the real repo Dockerfile exists.
    const originalExistsSync = fs.existsSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (path.basename(String(p)) === "Dockerfile") {
        return false;
      }
      return originalExistsSync(p);
    });

    try {
      await expect(createSandboxPlan(workspace, {})).rejects.toThrow(
        /Sandbox Dockerfile not found/i
      );
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("throws when --docker-socket is requested but /var/run/docker.sock is absent", async () => {
    const workspace = makeWorkspace();
    // Always exercise this guard regardless of host environment by mocking
    // fs.existsSync to return false specifically for the docker socket path.
    const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
    const originalExistsSync = fs.existsSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (String(p) === DOCKER_SOCKET_PATH) {
        return false;
      }
      return originalExistsSync(p);
    });

    try {
      await expect(createSandboxPlan(workspace, { dockerSocket: true })).rejects.toThrow(
        /docker\.sock.*not found|Start Docker|omit --docker-socket/i
      );
    } finally {
      existsSpy.mockRestore();
    }
  });
});

// ── buildDockerRunCommand (positive docker-socket mount) ─────────────────────

describe("buildDockerRunCommand — docker-socket mount", () => {
  it("includes /var/run/docker.sock mount when dockerSocket is true", () => {
    const args = buildDockerRunCommand(
      {
        workspacePath: "/tmp/test-workspace",
        image: "agent-preflight:local",
        dockerSocket: true,
        tty: false,
        homeDir: os.homedir(),
      },
      ["run", "/workspace"]
    );
    expect(args).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("excludes docker socket mount when dockerSocket is false", () => {
    const args = buildDockerRunCommand(
      {
        workspacePath: "/tmp/test-workspace",
        image: "agent-preflight:local",
        dockerSocket: false,
        tty: false,
        homeDir: os.homedir(),
      },
      ["run", "/workspace"]
    );
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });
});

// ── runSandbox ────────────────────────────────────────────────────────────────

describe("runSandbox — --print mode", () => {
  it("prints the docker run command and returns without executing docker run", async () => {
    const workspace = makeWorkspace();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSandbox(workspace, { print: true });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("docker");

    // Verify no docker run was invoked (localImageExists may call execa for
    // image inspect, but the run command itself must NOT be executed).
    const wasDockerRunInvoked = mockExeca.mock.calls.some(
      (call) => call[0] === "docker" && Array.isArray(call[1]) && call[1][0] === "run"
    );
    expect(wasDockerRunInvoked).toBe(false);

    consoleSpy.mockRestore();
  });
});

describe("runSandbox — docker absent", () => {
  it("throws when docker is not available in PATH", async () => {
    const workspace = makeWorkspace();

    // Make commandExists("docker") return false by having spawnSync set an error
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === "docker") {
        return { status: null, error: new Error("ENOENT: docker not found") };
      }
      return { status: 0, error: undefined, stdout: "" };
    });

    await expect(runSandbox(workspace, {})).rejects.toThrow(
      /Docker is not installed|not available in PATH/i
    );
  });
});

describe("runSandbox — success path", () => {
  it("exits with the docker run command exit code", async () => {
    const workspace = makeWorkspace();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    // First call: localImageExists (returns exitCode 1 → image missing → autoBuild)
    // Second call: docker build (success)
    // Third call: docker run (exits 0)
    mockExeca
      .mockResolvedValueOnce({ exitCode: 1 })    // localImageExists → image absent
      .mockResolvedValueOnce({ exitCode: 0 })    // runDockerCommand (build)
      .mockResolvedValueOnce({ exitCode: 0 });   // docker run itself

    await runSandbox(workspace, {});

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("propagates non-zero exit code from docker run", async () => {
    const workspace = makeWorkspace();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    mockExeca
      .mockResolvedValueOnce({ exitCode: 1 })    // localImageExists → absent
      .mockResolvedValueOnce({ exitCode: 0 })    // build
      .mockResolvedValueOnce({ exitCode: 2 });   // docker run exits 2

    await runSandbox(workspace, {});

    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });
});
