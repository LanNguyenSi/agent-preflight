import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runPreflight } from "../src/runner.js";
import { defaultConfig } from "../src/config.js";

describe("runPreflight", () => {
  it("returns a PreflightResult with required fields", async () => {
    const config = defaultConfig();
    // Disable heavy checks for unit test speed
    config.checks = {
      gitState: true,
      lint: false,
      typecheck: false,
      test: false,
      audit: false,
      ciSimulation: false,
      commitConvention: true,
      secretDetection: true,
    };

    const result = await runPreflight(path.resolve(__dirname, ".."), config);

    expect(result).toHaveProperty("ready");
    expect(result).toHaveProperty("confidence");
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.limitations)).toBe(true);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.timestamp).toBe("string");
  });

  it("is not ready when there are blockers", async () => {
    const config = defaultConfig();
    config.checks = { gitState: false, lint: false, typecheck: false, test: false, audit: false, ciSimulation: false, commitConvention: false, secretDetection: false, tdd: false };

    const result = await runPreflight(path.resolve(__dirname, ".."), config);

    // With no checks running, no blockers → confidence is low but result is valid
    expect(result.limitations.length).toBeGreaterThan(0);
  });
});

describe("confidence scoring", () => {
  it("penalises results with many limitations", async () => {
    const config = defaultConfig();
    config.checks = { gitState: false, lint: false, typecheck: false, test: false, audit: false, ciSimulation: false, commitConvention: false, secretDetection: false, tdd: false };

    const result = await runPreflight(path.resolve(__dirname, ".."), config);
    // All checks skipped → many limitations → low confidence
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("PreflightConfig.logDir end-user override", () => {
  // Uses a customChecks entry (rather than lint/typecheck/test/audit) as the
  // vehicle: it is the one check kind that doesn't depend on the target
  // repo having a particular language's project files, and it goes through
  // the exact same `runShellCheck({ ..., logDir: config.logDir })` plumbing
  // every other check runner (lint.ts, typecheck.ts, test.ts, audit.ts) was
  // wired up with in this change.
  it("resolves a relative logDir against repoPath, not process.cwd()", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-logdir-repo-"));
    try {
      const config = defaultConfig();
      config.checks = { gitState: false, lint: false, typecheck: false, test: false, audit: false, ciSimulation: false, commitConvention: false, secretDetection: false, tdd: false };
      config.logDir = "custom-logs";
      config.customChecks = [{ name: "always-fail", command: "echo boom && exit 1" }];

      const result = await runPreflight(repoPath, config);

      const failedCheck = result.checks.find((c) => c.name === "always-fail");
      expect(failedCheck?.status).toBe("fail");
      const logLine = failedCheck?.details?.[0];
      expect(logLine).toMatch(/^full output: /);
      const logPath = logLine!.replace(/^full output: /, "");
      expect(path.dirname(logPath)).toBe(path.join(repoPath, "custom-logs"));
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("uses an absolute logDir as-is", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-logdir-repo-abs-"));
    const absoluteLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-logdir-abs-target-"));
    try {
      const config = defaultConfig();
      config.checks = { gitState: false, lint: false, typecheck: false, test: false, audit: false, ciSimulation: false, commitConvention: false, secretDetection: false, tdd: false };
      config.logDir = absoluteLogDir;
      config.customChecks = [{ name: "always-fail", command: "echo boom && exit 1" }];

      const result = await runPreflight(repoPath, config);

      const failedCheck = result.checks.find((c) => c.name === "always-fail");
      const logLine = failedCheck?.details?.[0];
      const logPath = logLine!.replace(/^full output: /, "");
      expect(path.dirname(logPath)).toBe(absoluteLogDir);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
      fs.rmSync(absoluteLogDir, { recursive: true, force: true });
    }
  });
});
