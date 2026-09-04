import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { runAuditChecks, npmAuditRunner } from "../src/checks/audit.js";
import { runPreflight } from "../src/runner.js";
import { mockNpmAudit } from "./helpers/npm-audit-mock.js";

describe("runAuditChecks npm branch (through the npmAuditRunner seam)", () => {
  let repoPath: string;
  let restore: (() => void) | undefined;

  beforeAll(async () => {
    // A minimal Node project: hasNodeProject() only requires a readable
    // package.json (see src/checks/shared.ts#hasNodeProject).
    repoPath = path.join(os.tmpdir(), `preflight-audit-unit-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "fixture" }));
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("reports pass on a clean audit", async () => {
    restore = mockNpmAudit({
      exitCode: 0,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm).toBeDefined();
    expect(npm?.status).toBe("pass");
    expect(npm?.confidenceContribution).toBe(0.15);
    expect(npm?.kind).toBe("audit");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("reports fail with the vulnerability count when critical/high findings exist", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 1 } } }),
    });

    const { checks } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("fail");
    expect(npm?.message).toBe("0 critical, 1 high vulnerabilities found");
  });

  it("reports warn on a non-zero exit with no critical/high findings", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
    });

    const { checks } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
  });

  it("reports skip with a limitation when the run times out", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(npm?.message).toContain("registry advisory endpoint unavailable");
    expect(npm?.message).toContain("timed out after");
    expect(
      limitations.some((l) => l === "npm audit skipped: registry advisory endpoint unavailable (timed out after 90s)")
    ).toBe(true);
  });

  it("reports skip with a limitation on an endpoint error printed to stderr with empty stdout", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: "",
      stderr: "npm error audit endpoint returned an error",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(
      limitations.some((l) => l.startsWith("npm audit skipped: registry advisory endpoint unavailable"))
    ).toBe(true);
  });

  it("reports skip on a JSON error envelope with no vulnerability metadata", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "E503", summary: "Service Unavailable" } }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(
      limitations.some((l) => l.startsWith("npm audit skipped: registry advisory endpoint unavailable"))
    ).toBe(true);
  });
});

describe("npmAuditRunner real timeout (no mock: exercises execa's own timeout option)", () => {
  let repoPath: string;
  let binDir: string;
  let originalPath: string | undefined;
  let originalTimeoutMs: number;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-audit-real-timeout-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "fixture" }));

    // A fake `npm` that sleeps far longer than the lowered timeoutMs below,
    // placed first on PATH so `bash -lc "npm audit --json"` resolves to it
    // instead of the real npm.
    binDir = path.join(os.tmpdir(), `preflight-audit-fake-npm-${Date.now()}`);
    await fs.mkdir(binDir, { recursive: true });
    const fakeNpm = path.join(binDir, "npm");
    await fs.writeFile(fakeNpm, "#!/bin/sh\nsleep 5\necho '{}'\n");
    await fs.chmod(fakeNpm, 0o755);

    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
    if (binDir) await fs.rm(binDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalTimeoutMs = npmAuditRunner.timeoutMs;
    npmAuditRunner.timeoutMs = 300;
  });

  afterEach(() => {
    npmAuditRunner.timeoutMs = originalTimeoutMs;
  });

  it("kills the hung npm audit and reports skip with a limitation", async () => {
    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(npm?.message).toContain("registry advisory endpoint unavailable");
    expect(
      limitations.some((l) => l.startsWith("npm audit skipped: registry advisory endpoint unavailable"))
    ).toBe(true);
  }, 10_000);
});

describe("npm audit unavailable outcome through runPreflight", () => {
  let repoPath: string;
  let restore: (() => void) | undefined;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-audit-runpreflight-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "fixture" }));
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const baseConfig = {
    checks: {
      gitState: false,
      lint: false,
      typecheck: false,
      test: false,
      audit: true,
      ciSimulation: false,
      commitConvention: false,
      secretDetection: false,
      tdd: false,
    },
  };

  it("stays ready and does not count a skipped audit as passed", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: "",
      stderr: "npm error audit endpoint returned an error",
      timedOut: false,
    });

    const skippedResult = await runPreflight(repoPath, baseConfig);
    restore();

    restore = mockNpmAudit({
      exitCode: 0,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
    });
    const cleanResult = await runPreflight(repoPath, baseConfig);

    expect(skippedResult.ready).toBe(true);
    const npmCheck = skippedResult.checks.find((c) => c.name === "npm-audit");
    expect(npmCheck?.status).toBe("skip");
    expect(skippedResult.confidence).toBeLessThan(cleanResult.confidence);
  });
});
