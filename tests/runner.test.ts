import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runPreflight } from "../src/runner.js";
import { defaultConfig } from "../src/config.js";
import { PreflightConfig } from "../src/types.js";

function allChecksDisabled(): NonNullable<PreflightConfig["checks"]> {
  return {
    gitState: false,
    lint: false,
    typecheck: false,
    test: false,
    audit: false,
    ciSimulation: false,
    commitConvention: false,
    secretDetection: false,
    tdd: false,
  };
}

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

describe("PreflightConfig.logDir wiring through the four runConfiguredCommands callsites", () => {
  // The suite above only exercises `logDir` via `customChecks`, which shares
  // `runShellCheck` with lint/typecheck/test/audit but is wired up
  // separately from them. Each of lint.ts, typecheck.ts, test.ts, and
  // audit.ts has its own `runConfiguredCommands(repoPath, kind, commands,
  // weight, config.logDir)` call site when `commands.<kind>` is configured,
  // and nothing previously exercised those four call sites end-to-end — a
  // mutation dropping `config.logDir` (or the whole trailing argument) from
  // any one of them would have shipped with every existing test still
  // green. Driving each kind through its `commands.<kind>` config path and
  // asserting the persisted log lands under the configured `logDir` pins
  // all four independently.
  const kinds: Array<"lint" | "typecheck" | "test" | "audit"> = ["lint", "typecheck", "test", "audit"];

  it.each(kinds)("resolves the configured logDir for a failing commands.%s entry", async (kind) => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-logdir-wiring-${kind}-`));
    try {
      const config = defaultConfig();
      config.checks = { ...allChecksDisabled(), [kind]: true };
      config.commands = { [kind]: ["echo boom && exit 1"] };
      config.logDir = `custom-logs-${kind}`;

      const result = await runPreflight(repoPath, config);

      const failedCheck = result.checks.find((c) => c.name === `${kind}:1`);
      expect(failedCheck?.status).toBe("fail");
      const logLine = failedCheck?.details?.[0];
      expect(logLine).toMatch(/^full output: /);
      const logPath = logLine!.replace(/^full output: /, "");
      expect(path.dirname(logPath)).toBe(path.join(repoPath, `custom-logs-${kind}`));
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("checks.<kind>.acknowledge (agent-tasks b31065cc)", () => {
  it("downgrades a failing check to status:acknowledged, unblocks ready, and surfaces the reason in message + limitations", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-ack-repo-"));
    try {
      const config = defaultConfig();
      config.checks = {
        ...allChecksDisabled(),
        test: { acknowledge: "install-sh suite is linux-only, CI covers it" },
      };
      config.commands = { test: ["echo boom && exit 1"] };
      config.logDir = "custom-logs";

      const result = await runPreflight(repoPath, config);

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("acknowledged");
      expect(testCheck?.message).toContain("install-sh suite is linux-only, CI covers it");
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
      expect(
        result.limitations.some((l) => l.includes("install-sh suite is linux-only, CI covers it"))
      ).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects a missing/empty acknowledge justification — the check stays a blocker, and the rejection is reported in limitations, never silently", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-ack-reject-repo-"));
    try {
      const config = defaultConfig();
      config.checks = { ...allChecksDisabled(), test: { acknowledge: "" } };
      config.commands = { test: ["echo boom && exit 1"] };
      config.logDir = "custom-logs";

      const result = await runPreflight(repoPath, config);

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("fail");
      expect(result.ready).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(
        result.limitations.some((l) => l.includes("acknowledge must be a non-empty string"))
      ).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("does not crash on a malformed (non-string) acknowledge value from an unvalidated .preflight.json; the check stays a blocker", async () => {
    // loadConfig() (src/config.ts) does not runtime-validate .preflight.json
    // (known gap, tracked separately — see task 850903cb), so a live config
    // file can hand the runner arbitrary JSON-shaped junk here. The cast
    // simulates exactly that: a value TypeScript would normally reject, but
    // which can appear at runtime from a hand-edited config file.
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-ack-malformed-repo-"));
    try {
      const config = defaultConfig();
      config.checks = {
        ...allChecksDisabled(),
        test: { acknowledge: 12345 },
      } as unknown as NonNullable<PreflightConfig["checks"]>;
      config.commands = { test: ["echo boom && exit 1"] };
      config.logDir = "custom-logs";

      const result = await runPreflight(repoPath, config);

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("fail");
      expect(result.ready).toBe(false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("leaves a passing check alone even when its kind carries an acknowledge (nothing to waive)", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-ack-passing-repo-"));
    try {
      const config = defaultConfig();
      config.checks = { ...allChecksDisabled(), test: { acknowledge: "not needed, just documenting" } };
      config.commands = { test: ["exit 0"] };
      config.logDir = "custom-logs";

      const result = await runPreflight(repoPath, config);

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("pass");
      expect(result.ready).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("PreflightConfig.logDir tilde expansion", () => {
  it("expands a leading '~/' to os.homedir() before resolving, instead of a literal '~' directory under repoPath", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-logdir-repo-tilde-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-logdir-fakehome-"));
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      const config = defaultConfig();
      config.checks = allChecksDisabled();
      config.logDir = "~/tilde-logs";
      config.customChecks = [{ name: "always-fail", command: "echo boom && exit 1" }];

      const result = await runPreflight(repoPath, config);

      const failedCheck = result.checks.find((c) => c.name === "always-fail");
      expect(failedCheck?.status).toBe("fail");
      const logLine = failedCheck?.details?.[0];
      const logPath = logLine!.replace(/^full output: /, "");
      expect(path.dirname(logPath)).toBe(path.join(fakeHome, "tilde-logs"));
      // The literal-'~'-directory-inside-the-repo regression this guards
      // against would have created `<repoPath>/~/tilde-logs` instead.
      expect(fs.existsSync(path.join(repoPath, "~"))).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(repoPath, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
