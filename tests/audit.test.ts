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

  // Negative controls (round 2 review): a fail-open classifier that matches
  // unavailable markers regardless of what parsed, or that never checks the
  // exit code, keeps making these five green -- each one pins a boundary the
  // classifier must respect.

  it("reports fail with the count, not skip, when a real finding's exit carries a registry-marker stderr warning", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 2, high: 3 } } }),
      stderr: "npm warn registry Using stale data due to ECONNRESET during revalidation",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("fail");
    expect(npm?.message).toBe("2 critical, 3 high vulnerabilities found");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("reports pass, not skip, on a clean exit-0 report with a benign stderr retry warning", async () => {
    restore = mockNpmAudit({
      exitCode: 0,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
      stderr: "npm warn registry request to https://registry.npmjs.org failed, reason: ETIMEDOUT (retrying)",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("pass");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("reports warn naming the local failure, not skip, on a real ENOLOCK error envelope", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({
        error: {
          code: "ENOLOCK",
          summary: "This command requires an existing lockfile.",
          detail: "Try creating one first with: npm i --package-lock-only",
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
    expect(npm?.message).toBe("npm audit failed: This command requires an existing lockfile.");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("reports fail, not skip, when a marker token only appears inside the parsed report body", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({
        metadata: { vulnerabilities: { critical: 1, high: 0 } },
        advisories: {
          "1": { title: "Unhandled ECONNRESET leads to DoS", severity: "critical" },
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("fail");
    expect(npm?.message).toBe("1 critical, 0 high vulnerabilities found");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("reports skip naming E503 on a registry-attributable error envelope with no summary", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "E503" } }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(npm?.message).toContain("E503");
    expect(
      limitations.some((l) => l === "npm audit skipped: registry advisory endpoint unavailable (E503)")
    ).toBe(true);
  });

  it("reports warn, not skip, on a non-zero exit with no JSON and no marker text at all", async () => {
    restore = mockNpmAudit({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });
});

describe("npmAuditRunner real timeout (no mock: exercises execa's own timeout option)", () => {
  // Drives a REAL `npm audit --json` (no `npmAuditRunner.run` mock) against
  // a repo with a minimal, dependency-free but valid package-lock.json, so
  // an unbounded run completes quickly on its own (~150-250ms measured
  // locally: no lockfile at all makes npm fail immediately with an
  // "ENOLOCK" JSON error envelope, which this check already classifies as
  // `skip` on its own — that would make this test unable to tell a real
  // timeout kill apart from a fast local error, since both land on `skip`.
  // A clean, complete-able audit that resolves to `pass` on its own gives
  // the timeout mutation something to break). `npmAuditRunner.timeoutMs` is
  // lowered far below that real completion time for this test only, so
  // execa's own `timeout` kills the real child process before npm can
  // finish — proving the timeout option is actually wired up, not just
  // documented.
  //
  // A fake, PATH-shadowed `npm` binary was tried first and rejected: `npm
  // audit`'s seam shells out via `bash -lc`, a login shell, and macOS's
  // `/usr/libexec/path_helper` (sourced from /etc/profile) rebuilds PATH on
  // every login-shell invocation, always placing /usr/local/bin and
  // /opt/homebrew/bin (where the real `npm` lives) ahead of anything
  // prepended to PATH beforehand — verified empirically (`bash -lc npm
  // audit --json` against a fake npm dir prepended to PATH still ran the
  // real npm). Shadowing it would require writing into /usr/local/bin,
  // which is root-owned here.
  let repoPath: string;
  let originalTimeoutMs: number;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-audit-real-timeout-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "audit-real-timeout-fixture", version: "1.0.0", private: true })
    );
    // A minimal, self-consistent, dependency-free lockfile: real `npm
    // audit --json` resolves this without reaching the network (nothing to
    // check against advisories) and exits 0 with a clean report.
    await fs.writeFile(
      path.join(repoPath, "package-lock.json"),
      JSON.stringify({
        name: "audit-real-timeout-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "audit-real-timeout-fixture", version: "1.0.0" },
        },
      })
    );
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalTimeoutMs = npmAuditRunner.timeoutMs;
    // Comfortably below the ~150-250ms a real, complete `npm audit --json`
    // run against the fixture above takes, and comfortably above bare
    // process-spawn time, so the kill is reliable in both directions.
    npmAuditRunner.timeoutMs = 100;
  });

  afterEach(() => {
    npmAuditRunner.timeoutMs = originalTimeoutMs;
  });

  it("kills the real npm audit before it completes and reports skip with a limitation", async () => {
    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(npm?.message).toContain("registry advisory endpoint unavailable");
    expect(npm?.message).toContain("timed out after");
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
