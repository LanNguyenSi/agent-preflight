import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  MCP_ALLOW_SHELL_ENV,
  SHELL_SKIPPED_MESSAGE,
  CI_SIMULATION_SKIPPED_MESSAGE,
  mcpShellExecutionAllowed,
  stripShellExecution,
} from "../src/shellGate.js";
import { runPreflight } from "../src/runner.js";
import type { PreflightConfig } from "../src/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mcpShellExecutionAllowed", () => {
  it("uses the documented variable name", () => {
    expect(MCP_ALLOW_SHELL_ENV).toBe("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS");
  });

  it.each(["", "0", "true", "yes", "1 ", "01", "TRUE"])("is false for %j", (value) => {
    expect(mcpShellExecutionAllowed({ PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS: value })).toBe(false);
  });

  it("is true only for the exact value 1", () => {
    expect(mcpShellExecutionAllowed({ PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS: "1" })).toBe(true);
  });

  it("is false when the variable is unset", () => {
    expect(mcpShellExecutionAllowed({})).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "1");
    expect(mcpShellExecutionAllowed()).toBe(true);
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "0");
    expect(mcpShellExecutionAllowed()).toBe(false);
  });
});

describe("stripShellExecution", () => {
  const skip = (name: string, kind: string) => ({
    name,
    kind,
    status: "skip",
    message: SHELL_SKIPPED_MESSAGE,
    durationMs: 0,
    confidenceContribution: 0,
  });

  it("removes customChecks and commands.* and reports one skip per entry", () => {
    const config: PreflightConfig = {
      customChecks: [{ name: "smoke", command: "x" }],
      commands: { lint: ["a", { run: "b", name: "my-lint" }], test: ["c"] },
    };
    const clone = structuredClone(config);

    const result = stripShellExecution(config);

    expect(result.config.customChecks).toEqual([]);
    expect(result.config.commands?.lint).toBeUndefined();
    expect(result.config.commands?.test).toBeUndefined();
    expect(result.config.checks).toEqual({ lint: false, test: false });
    expect(result.skipped).toEqual([
      skip("smoke", "custom"),
      skip("lint:1", "lint"),
      skip("my-lint", "lint"),
      skip("test:1", "test"),
    ]);
    expect(SHELL_SKIPPED_MESSAGE).toBe(
      "Skipped: shell commands from the repo config are disabled on the MCP surface; set PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1 in the MCP server environment to enable them"
    );
    expect(result.limitations).toEqual([
      'MCP: 4 shell command(s) from the repo config were not run (PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS is not "1")',
    ]);
    expect(config).toEqual(clone);
  });

  it("skips CI simulation with an honest entry, switches it off and drops repo actFlags", () => {
    const config: PreflightConfig = {
      checks: { ciSimulation: true, lint: false },
      actFlags: ["--dryrun=false", "-P", "ubuntu-latest=-self-hosted"],
    };
    const clone = structuredClone(config);
    const result = stripShellExecution(config);
    expect(result.config.checks).toEqual({ ciSimulation: false, lint: false });
    expect(result.config.actFlags).toBeUndefined();
    expect(result.skipped).toEqual([
      {
        name: "act-dry-run",
        kind: "ci-simulation",
        status: "skip",
        message: CI_SIMULATION_SKIPPED_MESSAGE,
        durationMs: 0,
        confidenceContribution: 0,
      },
    ]);
    expect(CI_SIMULATION_SKIPPED_MESSAGE).toContain("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1");
    expect(result.limitations.some((l) => l.includes("CI simulation was not run"))).toBe(true);
    expect(config).toEqual(clone);
  });

  it("leaves a config without ciSimulation untouched by the CI gate", () => {
    const config: PreflightConfig = { checks: { ciSimulation: false }, actFlags: ["--x"] };
    const result = stripShellExecution(config);
    expect(result.skipped).toEqual([]);
    expect(result.config.actFlags).toEqual(["--x"]);
  });

  it("names unnamed entries by their one-based position within the kind", () => {
    const { skipped } = stripShellExecution({ commands: { audit: ["a", "b", "c"] } });
    expect(skipped.map((c) => c.name)).toEqual(["audit:1", "audit:2", "audit:3"]);
  });

  it("returns no skips and no limitations when the config has no shell entries", () => {
    const config: PreflightConfig = { checks: { lint: false } };
    const result = stripShellExecution(config);
    expect(result.skipped).toEqual([]);
    expect(result.limitations).toEqual([]);
    expect(result.config.checks).toEqual({ lint: false });
  });

  it("keeps a non-array commands entry in place without a skip so the runners report it", () => {
    const config = { commands: { lint: "npm run lint" } } as unknown as PreflightConfig;
    const result = stripShellExecution(config);
    expect(result.skipped).toEqual([]);
    expect(result.limitations).toEqual([]);
    expect(result.config.commands?.lint).toBe("npm run lint");
    expect(result.config.checks).toBeUndefined();
  });

  it("keeps an array with a malformed entry in place without a skip", () => {
    const config = { commands: { lint: [5], test: ["ok"] } } as unknown as PreflightConfig;
    const result = stripShellExecution(config);
    expect(result.config.commands?.lint).toEqual([5]);
    expect(result.config.commands?.test).toBeUndefined();
    expect(result.config.checks).toEqual({ test: false });
    expect(result.skipped.map((c) => c.kind)).toEqual(["test"]);
  });

  it("keeps every kind in place when commands carries an unrecognized key", () => {
    const config = { commands: { lint: ["a"], test: ["b"], surprise: ["c"] } } as unknown as PreflightConfig;
    const result = stripShellExecution(config);
    expect(result.config.commands).toEqual({ lint: ["a"], test: ["b"], surprise: ["c"] });
    expect(result.skipped).toEqual([]);
  });

  it("disables only the kinds whose configured commands were removed and keeps other toggles", () => {
    const config: PreflightConfig = {
      checks: { typecheck: true, audit: false, tdd: false },
      commands: { lint: ["a"], audit: ["b"], typecheck: [] },
    };
    const clone = structuredClone(config);
    const result = stripShellExecution(config);
    expect(result.config.checks).toEqual({ typecheck: true, audit: false, tdd: false, lint: false });
    expect(config).toEqual(clone);
  });

  it.each([null, 5])("keeps a commands.test of %j in place without throwing", (value) => {
    const config = { commands: { test: value } } as unknown as PreflightConfig;
    let result: ReturnType<typeof stripShellExecution> | undefined;
    expect(() => {
      result = stripShellExecution(config);
    }).not.toThrow();
    expect(result!.config.checks).toBeUndefined();
    expect(result!.config.commands?.test).toBe(value);
    expect(result!.skipped).toEqual([]);
  });

  it.each([null, 5, "npm run lint", ["npm run lint"]])(
    "keeps a non-object top-level commands value of %j unchanged and leaves checks alone",
    (value) => {
      const config = {
        commands: value,
        customChecks: [{ name: "n", command: "c" }],
      } as unknown as PreflightConfig;
      const result = stripShellExecution(config);
      expect(result.config.commands).toBe(value);
      expect(result.config.checks).toBeUndefined();
      expect(result.config.customChecks).toEqual([]);
      expect(result.skipped).toEqual([skip("n", "custom")]);
    }
  );

  it("leaves checks untouched when the config has only customChecks", () => {
    const result = stripShellExecution({ customChecks: [{ name: "n", command: "c" }] });
    expect(result.config.checks).toBeUndefined();
  });

  it("keeps unrelated config keys", () => {
    const result = stripShellExecution({
      requiredChecks: ["custom"],
      logDir: "x",
      customChecks: [{ name: "n", command: "c" }],
    });
    expect(result.config.requiredChecks).toEqual(["custom"]);
    expect(result.config.logDir).toBe("x");
  });
});

describe("runPreflight shell gate option", () => {
  const dirs: string[] = [];
  let marker: string;

  function fixture(): string {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-shellgate-"));
    dirs.push(repoPath);
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: "f", version: "1.0.0" }));
    execSync("git init", { cwd: repoPath });
    execSync('git config user.email "test@example.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });
    execSync("git add .", { cwd: repoPath });
    execSync('git commit -m "chore: fixture"', { cwd: repoPath });
    return repoPath;
  }

  function baseConfig(): PreflightConfig {
    return {
      checks: {
        gitState: false,
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        ciSimulation: false,
        commitConvention: false,
        secretDetection: false,
        tdd: false,
      },
      customChecks: [{ name: "marker-check", command: `touch ${marker}` }],
      logDir: "custom-logs",
    };
  }

  beforeEach(() => {
    marker = path.join(os.tmpdir(), `preflight-shellgate-marker-${process.pid}-${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    fs.rmSync(marker, { force: true });
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["", "unset"])("runs repo shell commands by default regardless of the MCP env (env %j)", async (value) => {
    if (value === "unset") vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", undefined);
    else vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", value);
    const repoPath = fixture();

    const config: PreflightConfig = { ...baseConfig(), logDir: "custom-logs" };
    const result = await runPreflight(repoPath, config);

    expect(fs.existsSync(marker)).toBe(true);
    const entry = result.checks.find((c) => c.name === "marker-check");
    expect(entry).toBeDefined();
    expect(entry!.status).not.toBe("skip");
  });

  it("skips repo shell commands when denyShellExecution is set", async () => {
    const repoPath = fixture();

    const config: PreflightConfig = { ...baseConfig(), logDir: "custom-logs" };
    const result = await runPreflight(repoPath, config, undefined, undefined, {
      denyShellExecution: true,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(result.checks.find((c) => c.name === "marker-check")?.status).toBe("skip");
    expect(result.limitations).toContain(
      'MCP: 1 shell command(s) from the repo config were not run (PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS is not "1")'
    );
  });

  it("does not let a skipped kind satisfy requiredChecks", async () => {
    const repoPath = fixture();

    const config: PreflightConfig = {
      ...baseConfig(),
      requiredChecks: ["custom"],
      logDir: "custom-logs",
    };
    const result = await runPreflight(repoPath, config, undefined, undefined, {
      denyShellExecution: true,
    });

    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.includes('Required check kind "custom"'))).toBe(true);
    expect(result.limitations).toContain(
      'MCP: 1 shell command(s) from the repo config were not run (PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS is not "1")'
    );
  });

  it("does not mutate the caller's config", async () => {
    const repoPath = fixture();
    const config: PreflightConfig = { ...baseConfig(), logDir: "custom-logs" };
    const clone = structuredClone(config);

    await runPreflight(repoPath, config, undefined, undefined, { denyShellExecution: true });

    expect(config).toEqual(clone);
  });
});
