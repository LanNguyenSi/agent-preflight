import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import * as net from "net";
import { runAuditChecks, npmAuditRunner, LOCAL_USAGE_ERROR_CODES } from "../src/checks/audit.js";
import { runPreflight } from "../src/runner.js";
import { mockNpmAudit } from "./helpers/npm-audit-mock.js";

// `npm audit --json` failure payloads captured by pointing the real npm at
// a refusing port, an unresolvable host, and a local stub answering 503.
// These are recordings, not hand-written approximations, and two npm
// majors are represented because the advisory endpoint path changed
// between them (`.../security/audits/quick` -> `.../security/advisories/bulk`).
// Only insignificant JSON whitespace was removed; the 503 payload's
// `headers` block is elided because it is irrelevant to classification and
// carries capture-time values.
//
// The one structural fact that drives the whole classifier: NONE of them
// carries an `error.code`. The human-readable reason sits in a TOP-LEVEL
// `message`, `error.summary`/`error.detail` are empty strings, and the
// HTTP-status case adds a top-level `statusCode`. That is why registry
// failures are not enumerated: there is nothing stable to enumerate. A
// non-zero exit without a parsed report is "the audit did not answer"
// (skip) by default, and only npm's own local usage codes turn it into a
// warn.
const REAL_UNAVAILABLE_PAYLOADS: {
  label: string;
  stdout: string;
  stderr: string;
  expectedCause: string;
}[] = [
  {
    label: "connection refused, quick-audit endpoint",
    stdout:
      '{"message":"request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9","error":{"summary":"","detail":""}}',
    stderr: "npm error audit endpoint returned an error",
    expectedCause:
      "request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  },
  {
    label: "unresolvable registry host, quick-audit endpoint",
    stdout:
      '{"message":"request to http://registry.does-not-exist-xyz.invalid/-/npm/v1/security/audits/quick failed, reason: getaddrinfo ENOTFOUND registry.does-not-exist-xyz.invalid","error":{"summary":"","detail":""}}',
    stderr: "npm error audit endpoint returned an error",
    expectedCause:
      "request to http://registry.does-not-exist-xyz.invalid/-/npm/v1/security/audits/quick failed, reason: getaddrinfo ENOTFOUND registry.does-not-exist-xyz.invalid",
  },
  {
    label: "connection refused, bulk-advisories endpoint",
    stdout:
      '{"message":"request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9","error":{"summary":"","detail":""}}',
    stderr:
      "npm warn audit request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9\nnpm error audit endpoint returned an error",
    expectedCause:
      "request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  },
  {
    // 161 characters: the only replay that exercises the one-line cause
    // clamp, so the limitation stays readable instead of carrying a full
    // npm message.
    label: "unresolvable registry host, bulk-advisories endpoint",
    stdout:
      '{"message":"request to http://registry.does-not-exist-xyz.invalid/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.does-not-exist-xyz.invalid","error":{"summary":"","detail":""}}',
    stderr:
      "npm warn audit request to http://registry.does-not-exist-xyz.invalid/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.does-not-exist-xyz.invalid\nnpm error audit endpoint returned an error",
    expectedCause:
      "request to http://registry.does-not-exist-xyz.invalid/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.does-not-exist-xyz.inv...",
  },
  {
    label: "registry answering HTTP 503",
    stdout:
      '{"message":"503 Service Unavailable - POST http://127.0.0.1:19503/-/npm/v1/security/advisories/bulk - Service Unavailable","method":"POST","uri":"http://127.0.0.1:19503/-/npm/v1/security/advisories/bulk","statusCode":503,"body":{"error":"Service Unavailable"},"error":{"summary":"","detail":""}}',
    stderr:
      "npm warn audit 503 Service Unavailable - POST http://127.0.0.1:19503/-/npm/v1/security/advisories/bulk - Service Unavailable\nnpm error audit endpoint returned an error",
    expectedCause:
      "503 Service Unavailable - POST http://127.0.0.1:19503/-/npm/v1/security/advisories/bulk - Service Unavailable",
  },
];

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

  it("coerces numeric-string severity counts instead of reading them as zero", async () => {
    // A `typeof value === "number"` guard would read a numeric-string
    // count as zero, silently downgrading a real fail to a false "no
    // vulnerabilities" warn.
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: "2", high: "3" } } }),
    });

    const { checks } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("fail");
    expect(npm?.message).toBe("2 critical, 3 high vulnerabilities found");
  });

  it("reports warn with zero counts when severity counts do not coerce to a number", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: "x", high: null } } }),
    });

    const { checks } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
    expect(npm?.message).toBeUndefined();
  });

  it("counts only numbers and numeric strings, never booleans or arrays", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: true, high: ["3"] } } }),
    });

    const { checks } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
    expect(npm?.message).toBeUndefined();
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
    expect(npm?.message).toContain("npm returned no report");
    expect(npm?.message).toContain("timed out after");
    expect(
      limitations.some((l) => l === "npm audit skipped: npm returned no report (timed out after 90s)")
    ).toBe(true);
  });

  it("reports fail with the count, not skip, when a killed run still left a complete parsed report", async () => {
    // A complete report is a real result even from a run execa later
    // killed for the timeout; a timeout with no report is the only case
    // that stays skip.
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 5, high: 5 } } }),
      stderr: "",
      timedOut: true,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("fail");
    expect(npm?.message).toBe("5 critical, 5 high vulnerabilities found");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  // Replays of the recorded payloads above. These are the primary outage
  // case, and the shape that a code-list classifier gets wrong: exit 1, no
  // vulnerability report, no `error.code`.
  for (const payload of REAL_UNAVAILABLE_PAYLOADS) {
    it(`reports skip naming the reason on the real ${payload.label} payload`, async () => {
      restore = mockNpmAudit({
        exitCode: 1,
        stdout: payload.stdout,
        stderr: payload.stderr,
        timedOut: false,
      });

      const { checks, limitations } = await runAuditChecks(repoPath, {});
      const npm = checks.find((c) => c.name === "npm-audit");

      expect(npm?.status).toBe("skip");
      expect(npm?.message).toBe(
        `npm audit not evaluated: npm returned no report (${payload.expectedCause})`
      );
      expect(limitations).toEqual([
        `npm audit skipped: npm returned no report (${payload.expectedCause})`,
      ]);
    });
  }

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
    expect(limitations).toEqual([
      "npm audit skipped: npm returned no report (npm error audit endpoint returned an error)",
    ]);
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
      limitations.some((l) => l.startsWith("npm audit skipped: npm returned no report"))
    ).toBe(true);
  });

  // Negative controls: a fail-open classifier that matches unavailable
  // markers regardless of what parsed, or that never checks the exit code,
  // keeps these green -- each pins a boundary the classifier must respect.

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

  it("reports warn naming the code when a local-usage envelope carries no summary", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "EUSAGE", summary: "", detail: "" } }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
    expect(npm?.message).toBe("npm audit failed: EUSAGE");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("pins the exact set of npm's local usage codes", () => {
    // Iterating LOCAL_USAGE_ERROR_CODES below to generate one test per code
    // cannot by itself catch a code silently dropped from the list: doing
    // so only removes the generated test, it does not fail any surviving
    // one, so the suite would just get one test smaller and still pass.
    // This fixed assertion is what actually fails when the list shrinks.
    expect(LOCAL_USAGE_ERROR_CODES).toEqual([
      "ENOLOCK",
      "EUSAGE",
      "EAUDITNOPJSON",
      "EAUDITNOLOCK",
      "ENOAUDIT",
      "EJSONPARSE",
      "ENOENT",
      "EACCES",
      "EPERM",
      "ENOTDIR",
    ]);
  });

  // Every one of npm's own local usage codes, not just the two spot-checked
  // above, must warn naming the local failure (with an empty summary, so
  // the message falls back to the code itself).
  for (const code of LOCAL_USAGE_ERROR_CODES) {
    it(`reports warn naming the local failure for npm's own ${code} usage code`, async () => {
      restore = mockNpmAudit({
        exitCode: 1,
        stdout: JSON.stringify({ error: { code, summary: "" } }),
        stderr: "",
        timedOut: false,
      });

      const { checks, limitations } = await runAuditChecks(repoPath, {});
      const npm = checks.find((c) => c.name === "npm-audit");

      expect(npm?.status).toBe("warn");
      expect(npm?.message).toBe(`npm audit failed: ${code}`);
      expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
    });
  }

  it("reports warn, not skip, when error.code is padded with whitespace", async () => {
    // `nonEmptyString` must return the TRIMMED value: a padded code that
    // still equals a local usage code once trimmed must not fall through
    // to the untrimmed lookup and miss the list.
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: " ENOLOCK ", summary: "" } }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("warn");
    expect(npm?.message).toBe("npm audit failed: ENOLOCK");
    expect(limitations.some((l) => l.includes("npm audit"))).toBe(false);
  });

  it("reports skip, not warn, on an envelope whose code is a network errno rather than a local usage code", async () => {
    // Only npm's own local usage codes are enumerated. An errno-shaped
    // code describes the transport, not the audit tool refusing to run, so
    // it must land on "not evaluated" like every other non-local failure.
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "ECONNREFUSED", summary: "connect ECONNREFUSED" } }),
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(limitations).toEqual([
      "npm audit skipped: npm returned no report (connect ECONNREFUSED)",
    ]);
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

  it("reports skip naming E503 on an error envelope with no summary", async () => {
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
      limitations.some((l) => l === "npm audit skipped: npm returned no report (E503)")
    ).toBe(true);
  });

  // Exit 0 without a parseable report is `pass`, unconditionally. npm
  // signalled success itself, so there is nothing here to report as a
  // finding and nothing that went unevaluated. These three pin that the
  // exit-code branch is real: a classifier that dropped it would send all
  // three into the "did not answer" path.

  it("reports pass, not skip, on exit 0 with empty stdout", async () => {
    restore = mockNpmAudit({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("pass");
    expect(limitations).toEqual([]);
  });

  it("reports pass, not skip, on exit 0 with output that is not JSON at all", async () => {
    restore = mockNpmAudit({
      exitCode: 0,
      stdout: "found 0 vulnerabilities",
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("pass");
    expect(limitations).toEqual([]);
  });

  it("reports pass, not skip, on exit 0 with empty stdout and a marker line on stderr", async () => {
    restore = mockNpmAudit({
      exitCode: 0,
      stdout: "",
      stderr: "npm warn audit request to https://registry.npmjs.org failed, reason: ETIMEDOUT (retrying)",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("pass");
    expect(limitations).toEqual([]);
  });

  it("reports skip naming the exit code on a non-zero exit with no JSON and no marker text at all", async () => {
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(limitations).toEqual([
      "npm audit skipped: npm returned no report (exit code 1)",
    ]);
  });

  it("reports skip naming a missing exit code when the child left none and did not time out", async () => {
    // execa leaves `exitCode` undefined on a signal kill. Undefined counts
    // as non-zero: npm never reported success, so the audit did not
    // answer.
    restore = mockNpmAudit({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      timedOut: false,
    });

    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(limitations).toEqual([
      "npm audit skipped: npm returned no report (exit code unknown)",
    ]);
  });
});

describe("npmAuditRunner real timeout (no mock: exercises execa's own timeout option)", () => {
  // The seam's `timeout` option is the one line this whole change hangs on,
  // so one test drives the REAL `npm audit --json` through `bash -lc` and
  // lets execa kill it. For that kill to be deterministic the child must be
  // unable to finish on its own: a fixture with one dependency makes npm
  // ask the registry for advisories, and `npm_config_registry` points it at
  // a loopback server that accepts the connection and never answers. npm
  // then waits on that socket for far longer than the bound, so the timeout
  // is the only thing that can end the run, whatever the process-start cost
  // of the login shell and of npm on the machine at hand. (An earlier form
  // of this test raced a 100 ms bound against a dependency-free audit that
  // completes in about 200 ms; on a CI runner whose login shell alone takes
  // about 120 ms to start, that race was lost once.)
  //
  // A fake, PATH-shadowed `npm` binary was tried first and rejected: the
  // seam shells out via `bash -lc`, a login shell, and macOS's
  // `/usr/libexec/path_helper` (sourced from /etc/profile) rebuilds PATH on
  // every login-shell invocation, always placing the system bin directories
  // (where the real `npm` lives) ahead of anything prepended to PATH
  // beforehand -- verified empirically. Shadowing it would require writing
  // into a root-owned system bin directory.
  let repoPath: string;
  let originalTimeoutMs: number;
  let originalRegistry: string | undefined;
  let server: net.Server;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    server = net.createServer((socket) => {
      // Accept, read, never reply: the client is left waiting for a response.
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    originalRegistry = process.env.npm_config_registry;
    // Inherited by the child through execa's default env; an environment
    // variable outranks every .npmrc, so a user- or CI-level registry
    // setting cannot redirect the request back to the real network.
    process.env.npm_config_registry = `http://127.0.0.1:${port}/`;

    repoPath = path.join(os.tmpdir(), `preflight-audit-real-timeout-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({
        name: "audit-real-timeout-fixture",
        version: "1.0.0",
        private: true,
        dependencies: { "left-pad": "1.3.0" },
      })
    );
    // One dependency in a self-consistent lockfile: `npm audit` reads it
    // without node_modules and has something to ask the registry about.
    await fs.writeFile(
      path.join(repoPath, "package-lock.json"),
      JSON.stringify({
        name: "audit-real-timeout-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "audit-real-timeout-fixture",
            version: "1.0.0",
            dependencies: { "left-pad": "1.3.0" },
          },
          "node_modules/left-pad": {
            version: "1.3.0",
            resolved: `http://127.0.0.1:${port}/left-pad/-/left-pad-1.3.0.tgz`,
          },
        },
      })
    );
  });

  afterAll(async () => {
    if (originalRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = originalRegistry;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalTimeoutMs = npmAuditRunner.timeoutMs;
    // Sub-second on purpose: this also pins the millisecond rendering of
    // the cause text. The bound is generous against process start-up and
    // irrelevant to completion, which the silent registry rules out.
    npmAuditRunner.timeoutMs = 500;
  });

  afterEach(() => {
    npmAuditRunner.timeoutMs = originalTimeoutMs;
  });

  it("kills the real npm audit that is waiting on a silent registry and reports skip with a limitation", async () => {
    const { checks, limitations } = await runAuditChecks(repoPath, {});
    const npm = checks.find((c) => c.name === "npm-audit");

    expect(npm?.status).toBe("skip");
    expect(npm?.message).toBe("npm audit not evaluated: npm returned no report (timed out after 500ms)");
    expect(limitations).toContain("npm audit skipped: npm returned no report (timed out after 500ms)");
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
    // The recorded connection-refused payload, i.e. the non-timeout
    // unavailable path end to end rather than through the classifier alone.
    const refused = REAL_UNAVAILABLE_PAYLOADS[0];
    restore = mockNpmAudit({
      exitCode: 1,
      stdout: refused.stdout,
      stderr: refused.stderr,
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
    expect(
      skippedResult.limitations.filter((l) => l.startsWith("npm audit skipped:"))
    ).toEqual([`npm audit skipped: npm returned no report (${refused.expectedCause})`]);
    expect(skippedResult.confidence).toBeLessThan(cleanResult.confidence);
  });
});
