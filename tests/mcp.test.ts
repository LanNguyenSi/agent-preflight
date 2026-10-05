import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp.js";

// Connects a fresh createMcpServer() instance to a fresh SDK Client over a
// linked in-memory transport pair — the in-process stand-in for a real
// `claude mcp add` registration (which needs a session restart to dogfood
// for real; see the task's "Pflicht-Verifikation" note).
//
// `progressIntervalMs` is forwarded to createMcpServer so progress-notification
// tests can use a short interval instead of waiting out the real ~10s default.
async function connectedClient(
  options: { progressIntervalMs?: number } = {}
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(options);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// A minimal git repo whose only enabled check is a deterministic, fast
// customChecks entry — either always failing (ready:false, no lint/tsc/npm
// audit spawned) or always passing (ready:true). logDir is set to a
// repo-local directory: the failing case's shell-check output would
// otherwise persist to the real ~/.agent-preflight/logs, which
// tests/setup/no-real-home-writes.globalSetup.ts fails the whole suite for
// (see runner.test.ts / critical-path.test.ts for the same pattern).
//
// `enableAudit`/`enableSecretDetection` (both default false, matching the
// original hardcoded fixture) let a caller turn those two checks ON in the
// fixture's own config, so a test can tell "the MCP noAudit/noSecrets flag
// actually suppressed the check" apart from "the fixture's config disabled
// it regardless of the flag" — the latter is what made the original
// noAudit/noSecrets assertions inert (mcp.test.ts review finding #3).
// `enableAudit` wires a deterministic `commands.audit` override (a bare
// `true`) instead of relying on the real `npm audit`, which would be slow
// and network-dependent for an empty fixture package.json.
// `packageScripts` becomes the fixture package.json `scripts`, so a test can
// tell a configured command from an autodetected repo script.
// `extra` is merged into the fixture's own `.preflight.json` top level, e.g.
// to add a key `validateConfig` warns about.
function makeFixtureRepo(
  customCommand: string,
  overrides: {
    enableAudit?: boolean;
    enableSecretDetection?: boolean;
    extra?: Record<string, unknown>;
    packageScripts?: Record<string, string>;
  } = {}
): string {
  const { enableAudit = false, enableSecretDetection = false, extra = {}, packageScripts } = overrides;
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-fixture-"));
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      ...(packageScripts ? { scripts: packageScripts } : {}),
    })
  );
  fs.writeFileSync(
    path.join(repoPath, ".preflight.json"),
    JSON.stringify({
      checks: {
        gitState: false,
        lint: false,
        typecheck: false,
        test: false,
        audit: enableAudit,
        ciSimulation: false,
        commitConvention: false,
        secretDetection: enableSecretDetection,
        tdd: false,
      },
      ...(enableAudit ? { commands: { audit: ["true"] } } : {}),
      customChecks: [{ name: "fixture-check", command: customCommand }],
      logDir: "custom-logs",
      ...extra,
    })
  );
  execSync("git init", { cwd: repoPath });
  execSync('git config user.email "test@example.com"', { cwd: repoPath });
  execSync('git config user.name "Test User"', { cwd: repoPath });
  execSync("git add .", { cwd: repoPath });
  execSync('git commit -m "chore: fixture"', { cwd: repoPath });
  return repoPath;
}

// An ambient PREFLIGHT_CONFIG would change which config every preflight_run
// call below loads; start each test from an unset variable. The shell gate
// starts OPEN here because almost every test below needs its fixture's
// customChecks entry to actually execute; the gate's own describe block
// overrides the value per test.
beforeEach(() => {
  vi.stubEnv("PREFLIGHT_CONFIG", "");
  vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP tool schema / registration", () => {
  it("lists preflight_run and preflight_batch with the ready:false and shell-surface warnings pinned in both descriptions", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["preflight_batch", "preflight_run"]);

      const run = tools.find((t) => t.name === "preflight_run")!;
      const batch = tools.find((t) => t.name === "preflight_batch")!;

      // Pinned verbatim: this is the exact sentence the task requires every
      // calling agent to see. A reworded or dropped warning must fail this
      // test, not just a code review.
      const readyFalseWarning = "ready:false means this PR will likely break CI; do not merge.";
      expect(run.description).toContain(readyFalseWarning);
      expect(batch.description).toContain(readyFalseWarning);

      // Same pinning discipline for the shell-execution security warning
      // (review finding #1): the target repo's .preflight.json can define
      // shell commands this tool executes, so a calling agent must see the
      // "trusted repositories only" guidance, not just a code comment.
      const shellSurfaceWarning =
        "The target repo's .preflight.json can define shell commands this tool will execute " +
        "(customChecks[].command, commands.lint/typecheck/test/audit); only point it at trusted repositories.";
      expect(run.description).toContain(shellSurfaceWarning);
      expect(batch.description).toContain(shellSurfaceWarning);

      // The default-off gate note, pinned verbatim in both descriptions.
      const shellGateNote =
        "Shell commands from the target repo's config are skipped unless the MCP server's environment " +
        "sets PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1; skipped entries are reported with status skip.";
      expect(run.description).toContain(shellGateNote);
      expect(batch.description).toContain(shellGateNote);
      expect(run.description).toContain("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS");
      expect(batch.description).toContain("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS");

      expect(Object.keys(run.inputSchema.properties ?? {}).sort()).toEqual(
        ["ciSimulation", "configPath", "noAudit", "noSecrets", "repoPath"].sort()
      );
      expect(Object.keys(batch.inputSchema.properties ?? {}).sort()).toEqual(
        ["exclude", "noAudit", "noSecrets", "only", "root"].sort()
      );
    } finally {
      await close();
    }
  });
});

describe("preflight_run", () => {
  let readyFalseRepo: string;

  beforeAll(() => {
    readyFalseRepo = makeFixtureRepo("echo boom && exit 1");
  });

  afterAll(() => {
    fs.rmSync(readyFalseRepo, { recursive: true, force: true });
  });

  it("returns the exact PreflightResult shape from `preflight run --json`, with ready:false for a failing fixture repo", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath: readyFalseRepo, noAudit: true, noSecrets: true },
      });

      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as Record<string, unknown>;

      // The mutation this guards against: hardcoding `ready: true` in the
      // tool handler regardless of the underlying runPreflight() result.
      expect(structured.ready).toBe(false);
      expect(typeof structured.confidence).toBe("number");
      expect(Array.isArray(structured.blockers)).toBe(true);
      expect((structured.blockers as string[]).length).toBeGreaterThan(0);
      expect(Array.isArray(structured.checks)).toBe(true);
      expect(
        (structured.checks as Array<{ name: string; status: string }>).some(
          (c) => c.name === "fixture-check" && c.status === "fail"
        )
      ).toBe(true);
      expect(typeof structured.durationMs).toBe("number");
      expect(typeof structured.timestamp).toBe("string");

      // noAudit/noSecrets threading is exercised properly (with the checks
      // actually enabled in the fixture config so the assertion isn't
      // trivially true either way) in the dedicated describe block below.

      // The text content mirrors structuredContent (same JSON, just also
      // rendered as text for text-only clients).
      const contentText = response.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(contentText[0].text)).toEqual(structured);
    } finally {
      await close();
    }
  });

  it("returns a structured isError result (not a crash) when repoPath does not exist", async () => {
    const { client, close } = await connectedClient();
    try {
      const missingPath = path.join(os.tmpdir(), `preflight-mcp-missing-${Date.now()}`);
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath: missingPath },
      });

      expect(response.isError).toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain(missingPath);
      // No structuredContent on the error path (would fail outputSchema validation).
      expect(response.structuredContent).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("returns a structured isError result (not a leaked ENOTDIR) when repoPath exists but is a file, not a directory", async () => {
    const { client, close } = await connectedClient();
    try {
      const filePath = path.join(os.tmpdir(), `preflight-mcp-not-a-dir-${Date.now()}.txt`);
      fs.writeFileSync(filePath, "not a directory");
      try {
        const response = await client.callTool({
          name: "preflight_run",
          arguments: { repoPath: filePath },
        });

        expect(response.isError).toBe(true);
        const content = response.content as Array<{ type: string; text: string }>;
        // The mutation this guards against: fs.existsSync(p), which is
        // true for a plain file too, letting the path fall through into
        // runPreflight() and leak a raw ENOTDIR instead of this tool's own
        // structured message.
        expect(content[0].text).toContain(filePath);
        expect(content[0].text).toContain("is not an existing directory");
        expect(content[0].text).not.toContain("ENOTDIR");
        expect(response.structuredContent).toBeUndefined();
      } finally {
        fs.rmSync(filePath, { force: true });
      }
    } finally {
      await close();
    }
  });
});

describe("preflight_run config warnings in limitations", () => {
  // The fixture config carries a top-level key `validateConfig` warns about;
  // the warning must reach structuredContent.limitations (prefixed
  // `config <path>:`), not just the server's console.warn.
  let repoPath: string;

  beforeAll(() => {
    repoPath = makeFixtureRepo("exit 0", { extra: { surpriseKey: true } });
  });

  afterAll(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("surfaces the repo config validation warning in structuredContent.limitations", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath, noAudit: true, noSecrets: true },
      });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as Record<string, unknown>;
      const limitations = structured.limitations as string[];
      const entry = limitations.find((l) => l.startsWith("config "));
      expect(entry).toBeDefined();
      expect(entry).toContain(path.join(repoPath, ".preflight.json"));
      expect(entry).toContain('"surpriseKey"');
    } finally {
      await close();
      warnSpy.mockRestore();
    }
  });
});

describe("preflight_run noAudit/noSecrets threading", () => {
  // Unlike readyFalseRepo above, this fixture has audit and secretDetection
  // ENABLED in its own .preflight.json config, so a check kind's presence
  // or absence in the response can only be explained by the MCP call's
  // noAudit/noSecrets arguments — not by the fixture's config already
  // disabling them regardless of the flag (the bug that made the original
  // assertions inert; review finding #3).
  let repoPath: string;

  beforeAll(() => {
    repoPath = makeFixtureRepo("exit 0", { enableAudit: true, enableSecretDetection: true });
  });

  afterAll(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  async function checkKinds(args: Record<string, unknown>): Promise<string[]> {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath, ...args },
      });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as { checks: Array<{ kind: string }> };
      return structured.checks.map((c) => c.kind);
    } finally {
      await close();
    }
  }

  it("includes both audit and secret-detection checks when neither flag is set", async () => {
    const kinds = await checkKinds({});
    expect(kinds).toContain("audit");
    expect(kinds).toContain("secret-detection");
  });

  it("omits audit but keeps secret-detection when noAudit is set", async () => {
    const kinds = await checkKinds({ noAudit: true });
    expect(kinds).not.toContain("audit");
    expect(kinds).toContain("secret-detection");
  });

  it("omits secret-detection but keeps audit when noSecrets is set", async () => {
    const kinds = await checkKinds({ noSecrets: true });
    expect(kinds).toContain("audit");
    expect(kinds).not.toContain("secret-detection");
  });

  it("omits both audit and secret-detection when both flags are set", async () => {
    const kinds = await checkKinds({ noAudit: true, noSecrets: true });
    expect(kinds).not.toContain("audit");
    expect(kinds).not.toContain("secret-detection");
  });
});

// agent-tasks b31065cc: the "acknowledged" CheckResult status must survive
// the MCP tool's outputSchema runtime validation (a strict z.enum missing
// the new value would make the SDK reject the tool response, not just fail
// typecheck) and still carry the justification through to the caller.
describe("preflight_run — acknowledged status through the MCP path", () => {
  let repoPath: string;

  beforeAll(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-ack-"));
    fs.writeFileSync(
      path.join(repoPath, ".preflight.json"),
      JSON.stringify({
        checks: {
          gitState: false,
          lint: false,
          typecheck: false,
          test: { acknowledge: "install-sh suite is linux-only, CI covers it" },
          audit: false,
          ciSimulation: false,
          commitConvention: false,
          secretDetection: false,
          tdd: false,
        },
        commands: { test: ["echo boom && exit 1"] },
        logDir: "custom-logs",
      })
    );
    execSync("git init", { cwd: repoPath });
    execSync('git config user.email "test@example.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });
    execSync("git add .", { cwd: repoPath });
    execSync('git commit -m "chore: fixture"', { cwd: repoPath });
  });

  afterAll(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns ready:true with a status:acknowledged check carrying the justification, no schema error", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath },
      });

      // A missing "acknowledged" enum member on the tool's outputSchema
      // would make the SDK reject this response as isError, not silently
      // pass — this assertion is the MCP-path regression guard.
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as Record<string, unknown>;
      expect(structured.ready).toBe(true);
      const checks = structured.checks as Array<{ name: string; status: string; message?: string }>;
      const acknowledged = checks.find((c) => c.status === "acknowledged");
      expect(acknowledged).toBeDefined();
      expect(acknowledged?.message).toContain("install-sh suite is linux-only, CI covers it");
    } finally {
      await close();
    }
  });
});

describe("preflight_batch", () => {
  let batchRoot: string;
  let repoPath: string;

  beforeAll(() => {
    batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-batch-"));
    const fixture = makeFixtureRepo("exit 0");
    repoPath = path.join(batchRoot, path.basename(fixture));
    fs.renameSync(fixture, repoPath);
  });

  afterAll(() => {
    fs.rmSync(batchRoot, { recursive: true, force: true });
  });

  it("aggregates a passing fixture repo the same way `preflight batch --json` does", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_batch",
        arguments: { root: batchRoot },
      });

      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as {
        total: number;
        ready: number;
        notReady: number;
        skipped: number;
        results: Array<{ repo: string; result: { ready: boolean } | null }>;
      };

      expect(structured.total).toBe(1);
      expect(structured.ready).toBe(1);
      expect(structured.notReady).toBe(0);
      expect(structured.skipped).toBe(0);
      expect(structured.results[0].repo).toBe(path.basename(repoPath));
      expect(structured.results[0].result?.ready).toBe(true);
    } finally {
      await close();
    }
  });

  it("returns a structured isError result (not a crash) when root does not exist", async () => {
    const { client, close } = await connectedClient();
    try {
      const missingRoot = path.join(os.tmpdir(), `preflight-mcp-missing-root-${Date.now()}`);
      const response = await client.callTool({
        name: "preflight_batch",
        arguments: { root: missingRoot },
      });

      expect(response.isError).toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain(missingRoot);
    } finally {
      await close();
    }
  });
});

describe("preflight_batch config warnings in limitations", () => {
  // Same contract as preflight_run's config warnings (see the
  // "preflight_run config warnings in limitations" describe): a repo config
  // validation warning must reach the per-repo result's limitations
  // (prefixed `config <path>:`), not just the server's console.warn.
  let batchRoot: string;
  let repoPath: string;

  beforeAll(() => {
    batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-batch-warnings-"));
    const fixture = makeFixtureRepo("exit 0", { extra: { surpriseKey: true } });
    repoPath = path.join(batchRoot, path.basename(fixture));
    fs.renameSync(fixture, repoPath);
  });

  afterAll(() => {
    fs.rmSync(batchRoot, { recursive: true, force: true });
  });

  it("surfaces the repo config validation warning in the repo result's limitations", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_batch",
        arguments: { root: batchRoot, noAudit: true, noSecrets: true },
      });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as {
        results: Array<{ repo: string; result: { limitations: string[] } | null }>;
      };
      expect(structured.results[0].repo).toBe(path.basename(repoPath));
      const limitations = structured.results[0].result?.limitations ?? [];
      const entry = limitations.find((l) => l.startsWith("config "));
      expect(entry).toBeDefined();
      expect(entry).toContain(path.join(repoPath, ".preflight.json"));
      expect(entry).toContain('"surpriseKey"');
    } finally {
      await close();
      warnSpy.mockRestore();
    }
  });
});

describe("preflight_batch only/exclude", () => {
  // Two repos in one root: `only`/`exclude` filtering has real signal only
  // when there's something to filter OUT. The single-repo batchRoot above
  // can't tell "only/exclude are threaded to runBatch correctly" apart
  // from "only/exclude are silently dropped and every repo runs anyway"
  // (review finding #4).
  let batchRoot: string;

  beforeAll(() => {
    batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-batch-filter-"));
    const alphaFixture = makeFixtureRepo("exit 0");
    const betaFixture = makeFixtureRepo("exit 0");
    fs.renameSync(alphaFixture, path.join(batchRoot, "alpha-repo"));
    fs.renameSync(betaFixture, path.join(batchRoot, "beta-repo"));
  });

  afterAll(() => {
    fs.rmSync(batchRoot, { recursive: true, force: true });
  });

  it("only limits results to the repo(s) matching the glob", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_batch",
        arguments: { root: batchRoot, only: "alpha-*" },
      });

      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as {
        total: number;
        results: Array<{ repo: string }>;
      };
      expect(structured.total).toBe(1);
      expect(structured.results.map((r) => r.repo)).toEqual(["alpha-repo"]);
    } finally {
      await close();
    }
  });

  it("exclude drops the matching repo and keeps the rest", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_batch",
        arguments: { root: batchRoot, exclude: "alpha-*" },
      });

      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as {
        total: number;
        results: Array<{ repo: string }>;
      };
      expect(structured.total).toBe(1);
      expect(structured.results.map((r) => r.repo)).toEqual(["beta-repo"]);
    } finally {
      await close();
    }
  });
});

describe("preflight_batch noAudit/noSecrets threading", () => {
  // Mirrors "preflight_run noAudit/noSecrets threading" above, but for
  // preflight_batch's own configOverride wiring (src/mcp.ts noAudit/
  // noSecrets lines just above the runBatch call). That block only
  // exercises preflight_run's threading; every existing preflight_batch
  // test uses a fixture with audit/secretDetection left at their default
  // false, so "the check is absent" and "the flag suppressed it" were
  // indistinguishable there — a mutant turning both configOverride lines
  // into no-ops stayed green. As in the preflight_run block, this fixture
  // has both checks ENABLED in its own .preflight.json.
  let batchRoot: string;
  let repoPath: string;

  beforeAll(() => {
    batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-batch-threading-"));
    const fixture = makeFixtureRepo("exit 0", { enableAudit: true, enableSecretDetection: true });
    repoPath = path.join(batchRoot, path.basename(fixture));
    fs.renameSync(fixture, repoPath);
  });

  afterAll(() => {
    fs.rmSync(batchRoot, { recursive: true, force: true });
  });

  async function checkKinds(args: Record<string, unknown>): Promise<string[]> {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_batch",
        arguments: { root: batchRoot, ...args },
      });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as {
        results: Array<{ result: { checks: Array<{ kind: string }> } | null }>;
      };
      return (structured.results[0].result?.checks ?? []).map((c) => c.kind);
    } finally {
      await close();
    }
  }

  it("includes both audit and secret-detection checks when neither flag is set", async () => {
    const kinds = await checkKinds({});
    expect(kinds).toContain("audit");
    expect(kinds).toContain("secret-detection");
  });

  it("omits audit but keeps secret-detection when noAudit is set", async () => {
    const kinds = await checkKinds({ noAudit: true });
    expect(kinds).not.toContain("audit");
    expect(kinds).toContain("secret-detection");
  });

  it("omits secret-detection but keeps audit when noSecrets is set", async () => {
    const kinds = await checkKinds({ noSecrets: true });
    expect(kinds).toContain("audit");
    expect(kinds).not.toContain("secret-detection");
  });
});

describe("progress notifications", () => {
  // A single test (per the task's "mind. ein Test" ask), using a short
  // 15ms progressIntervalMs (vs. the ~10s production default) so it does
  // not need to wait out a real interval, and a fixture-check that
  // sleeps for 300ms — long enough, at ~20x the interval, that at least
  // one tick reliably fires before the tool call resolves even under CI
  // scheduling jitter.
  it("sends at least one notifications/progress ping while preflight_run is still running, only when the caller attached a progressToken", async () => {
    const repoPath = makeFixtureRepo("sleep 0.3 && exit 0");
    try {
      const { client, close } = await connectedClient({ progressIntervalMs: 15 });
      try {
        const progressUpdates: number[] = [];
        const response = await client.callTool(
          { name: "preflight_run", arguments: { repoPath } },
          undefined,
          { onprogress: (progress) => progressUpdates.push(progress.progress) }
        );

        expect(response.isError).toBeFalsy();
        // The mutation this guards against: withProgressPings() becoming a
        // no-op (e.g. never checking extra._meta.progressToken, or never
        // starting the interval) — the client asked for progress via
        // onprogress (which makes the SDK attach a progressToken
        // automatically), so at least one ping must arrive.
        expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  // Negative counterpart to the test above: a caller that never passes
  // `onprogress` (so the SDK never attaches a `_meta.progressToken` to the
  // request — see protocol.js's `request()`) must receive zero
  // notifications/progress messages, not just "zero reaching *my*
  // onprogress callback". `client.setNotificationHandler` is registered
  // directly against the raw `ProgressNotificationSchema`, replacing the
  // SDK's own built-in routing for that method, so this observes every
  // notifications/progress message that actually crosses the wire —
  // independent of whether this client asked for any.
  it("sends no notifications/progress at all when the caller attaches no onprogress/progressToken", async () => {
    const repoPath = makeFixtureRepo("sleep 0.3 && exit 0");
    try {
      const { client, close } = await connectedClient({ progressIntervalMs: 15 });
      try {
        const rawProgressNotifications: unknown[] = [];
        client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
          rawProgressNotifications.push(notification);
        });

        const response = await client.callTool({
          name: "preflight_run",
          arguments: { repoPath },
        });

        expect(response.isError).toBeFalsy();
        // The mutation this guards against: withProgressPings() dropping
        // its `if (progressToken === undefined) return work();` guard,
        // which would start the ping interval unconditionally and send
        // notifications/progress to every caller, not just ones that
        // opted in via a progressToken.
        expect(rawProgressNotifications).toEqual([]);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!fs.existsSync(path.resolve(__dirname, "..", "dist", "mcp.js")))(
  "stdio smoke test (dist/mcp.js)",
  () => {
    // Every other test in this file drives createMcpServer() over an
    // in-memory transport. This is the one test that actually spawns the
    // built `node dist/mcp.js` binary and talks real stdio to it — the
    // shape a `claude mcp add preflight -- preflight-mcp` registration
    // exercises for real. Skipped (not failed) when dist/ hasn't been
    // built yet, since a fresh checkout's `npm test` shouldn't require a
    // prior `npm run build`.
    it("spawns the built server over stdio and lists both tools", async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(__dirname, "..", "dist", "mcp.js")],
      });
      const client = new Client({ name: "stdio-smoke-client", version: "0.0.0" });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(["preflight_batch", "preflight_run"]);
      } finally {
        await client.close();
      }
    }, 15_000);
  }
);

describe("preflight_run configPath", () => {
  let repoPath: string;
  let extDir: string;
  let externalConfig: string;

  beforeAll(() => {
    repoPath = makeFixtureRepo("exit 0");
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-extcfg-"));
    externalConfig = path.join(extDir, "shared.json");
    fs.writeFileSync(
      externalConfig,
      JSON.stringify({
        checks: {
          gitState: false, lint: false, typecheck: false, test: false, audit: false,
          ciSimulation: false, commitConvention: false, secretDetection: false, tdd: false,
        },
        customChecks: [{ name: "external-check", command: "exit 0" }],
        logDir: path.join(extDir, "logs"),
      })
    );
  });

  afterAll(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  it("applies the external config instead of the repo file and reports its source", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath, configPath: externalConfig },
      });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as {
        checks: Array<{ name: string }>;
        config: { source: string; path: string };
      };
      expect(structured.checks.map((c) => c.name)).toEqual(["external-check"]);
      expect(structured.config).toEqual({ source: "option", path: externalConfig });
    } finally {
      await close();
    }
  });

  it("resolves a relative configPath against the server's working directory", async () => {
    const { client, close } = await connectedClient();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(extDir);
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath, configPath: "shared.json" },
      });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as { config: { path: string } };
      expect(structured.config.path).toBe(externalConfig);
    } finally {
      cwdSpy.mockRestore();
      await close();
    }
  });

  it("returns a tool error and runs no check when the config file is missing", async () => {
    const { client, close } = await connectedClient();
    try {
      const missing = path.join(extDir, "missing.json");
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath, configPath: missing },
      });
      expect(response.isError).toBe(true);
      expect((response.content as Array<{ text: string }>)[0].text).toContain(missing);
      expect(response.structuredContent).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("uses PREFLIGHT_CONFIG as source env, and configPath beats it", async () => {
    const otherConfig = path.join(extDir, "other.json");
    fs.writeFileSync(
      otherConfig,
      JSON.stringify({
        checks: {
          gitState: false, lint: false, typecheck: false, test: false, audit: false,
          ciSimulation: false, commitConvention: false, secretDetection: false, tdd: false,
        },
        customChecks: [{ name: "other-check", command: "exit 0" }],
        logDir: path.join(extDir, "logs"),
      })
    );
    vi.stubEnv("PREFLIGHT_CONFIG", otherConfig);
    const { client, close } = await connectedClient();
    try {
      const viaEnv = await client.callTool({ name: "preflight_run", arguments: { repoPath } });
      const envResult = viaEnv.structuredContent as { checks: Array<{ name: string }>; config: unknown };
      expect(envResult.checks.map((c) => c.name)).toEqual(["other-check"]);
      expect(envResult.config).toEqual({ source: "env", path: otherConfig });

      const viaOption = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath, configPath: externalConfig },
      });
      const optionResult = viaOption.structuredContent as { checks: Array<{ name: string }>; config: unknown };
      expect(optionResult.checks.map((c) => c.name)).toEqual(["external-check"]);
      expect(optionResult.config).toEqual({ source: "option", path: externalConfig });
    } finally {
      await close();
    }
  });

  it("returns a tool error listing every problem for an explicit file with field warnings", async () => {
    const bad = path.join(extDir, "bad-fields.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({
        checks: { secretDetection: "yes" },
        customChecks: [{ name: "must-run", comand: "exit 1" }],
      })
    );
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({ name: "preflight_run", arguments: { repoPath, configPath: bad } });
      expect(response.isError).toBe(true);
      const text = (response.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("checks.secretDetection");
      expect(text).toContain("customChecks[0]");
      expect(response.structuredContent).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("reports the repo source when no configPath is given", async () => {
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({ name: "preflight_run", arguments: { repoPath } });
      const structured = response.structuredContent as { config: { source: string } };
      expect(structured.config.source).toBe("repo");
    } finally {
      await close();
    }
  });
});

describe("MCP shell execution gate", () => {
  const closedValues = ["", "0", "true", "yes", "1 ", "01", "TRUE"];
  const markers: string[] = [];
  const dirs: string[] = [];

  function markerPath(): string {
    const marker = path.join(
      os.tmpdir(),
      `preflight-mcp-marker-${process.pid}-${Date.now()}-${markers.length}`
    );
    markers.push(marker);
    return marker;
  }

  afterEach(() => {
    for (const marker of markers.splice(0)) fs.rmSync(marker, { force: true });
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  type RunChecks = Array<{ name: string; kind: string; status: string; message?: string }>;

  async function runOnFixture(command: string): Promise<{
    response: Awaited<ReturnType<Client["callTool"]>>;
    checks: RunChecks;
  }> {
    const repoPath = makeFixtureRepo(command);
    dirs.push(repoPath);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: "preflight_run",
        arguments: { repoPath },
      });
      const structured = response.structuredContent as { checks: RunChecks };
      return { response, checks: structured.checks };
    } finally {
      await close();
    }
  }

  it.each(closedValues)("keeps the gate closed for PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=%j (marker absent, entry skipped)", async (value) => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", value);
    const marker = markerPath();
    const { response, checks } = await runOnFixture(`touch ${marker}`);

    expect(response.isError).toBeFalsy();
    expect(fs.existsSync(marker)).toBe(false);
    const entry = checks.find((c) => c.name === "fixture-check");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("skip");
    expect(entry!.kind).toBe("custom");
    expect(entry!.message).toContain("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS");
  });

  it("is closed when the variable is unset", async () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", undefined);
    const marker = markerPath();
    const { checks } = await runOnFixture(`touch ${marker}`);

    expect(fs.existsSync(marker)).toBe(false);
    expect(checks.find((c) => c.name === "fixture-check")?.status).toBe("skip");
  });

  it("runs the command when the value is exactly \"1\" (pass)", async () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "1");
    const marker = markerPath();
    const { checks } = await runOnFixture(`touch ${marker}`);

    expect(fs.existsSync(marker)).toBe(true);
    expect(checks.find((c) => c.name === "fixture-check")?.status).toBe("pass");
  });

  it("runs the command when the value is exactly \"1\" (fail for a non-zero exit)", async () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "1");
    const marker = markerPath();
    const { checks } = await runOnFixture(`touch ${marker} && exit 1`);

    expect(fs.existsSync(marker)).toBe(true);
    expect(checks.find((c) => c.name === "fixture-check")?.status).toBe("fail");
  });

  it("returns the skipped check through the output schema with text content equal to structuredContent", async () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
    const { response } = await runOnFixture("exit 0");

    expect(response.isError).toBeFalsy();
    const content = response.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual(response.structuredContent);
  });

  it.each([
    ["lint", "lint"],
    ["test", "test"],
  ])("does not fall back to the repo's autodetected %s script when its configured commands are skipped", async (kind, toggle) => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
    const configured = markerPath();
    const scripted = markerPath();
    const repoPath = makeFixtureRepo("exit 0", {
      packageScripts: { [kind]: `touch ${scripted}` },
      extra: {
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
          [toggle]: true,
        },
        commands: { [kind]: [`touch ${configured}`] },
        requiredChecks: [kind],
      },
    });
    dirs.push(repoPath);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({ name: "preflight_run", arguments: { repoPath } });
      const structured = response.structuredContent as {
        ready: boolean;
        blockers: string[];
        checks: RunChecks;
      };
      expect(fs.existsSync(configured)).toBe(false);
      expect(fs.existsSync(scripted)).toBe(false);
      const ofKind = structured.checks.filter((c) => c.kind === kind);
      expect(ofKind.map((c) => c.status)).toEqual(["skip"]);
      expect(ofKind[0].message).toContain("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS");
      expect(structured.ready).toBe(false);
      expect(structured.blockers.some((b) => b.includes(`Required check kind "${kind}"`))).toBe(true);
    } finally {
      await close();
    }

    // Gate open: the configured command runs and the repo script does not.
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "1");
    const { client: openClient, close: closeOpen } = await connectedClient();
    try {
      const response = await openClient.callTool({ name: "preflight_run", arguments: { repoPath } });
      const structured = response.structuredContent as { checks: RunChecks };
      expect(fs.existsSync(configured)).toBe(true);
      expect(fs.existsSync(scripted)).toBe(false);
      expect(structured.checks.filter((c) => c.kind === kind).map((c) => c.status)).toEqual(["pass"]);
    } finally {
      await closeOpen();
    }
  });

  it("keeps a malformed top-level commands value as a configuration failure instead of autodetecting", async () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
    const scripted = markerPath();
    const repoPath = makeFixtureRepo("exit 0", {
      packageScripts: { lint: `touch ${scripted}` },
      extra: {
        checks: {
          gitState: false,
          lint: true,
          typecheck: false,
          test: false,
          audit: false,
          ciSimulation: false,
          commitConvention: false,
          secretDetection: false,
          tdd: false,
        },
        commands: null,
      },
    });
    dirs.push(repoPath);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({ name: "preflight_run", arguments: { repoPath } });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as { ready: boolean; checks: RunChecks };
      expect(fs.existsSync(scripted)).toBe(false);
      const lint = structured.checks.filter((c) => c.kind === "lint");
      expect(lint.map((c) => [c.name, c.status])).toEqual([["lint:configuration", "fail"]]);
      expect(structured.ready).toBe(false);
    } finally {
      await close();
    }
  });

  it.each([
    ["a non-array commands.lint", (marker: string) => ({ lint: 5, test: [`touch ${marker}`] })],
    ["an array with a malformed entry", (_marker: string) => ({ lint: [5] })],
    ["an unrecognized key beside a well-formed commands.lint", (marker: string) => ({ lint: [`touch ${marker}`], surprise: ["x"] })],
  ])("reports %s as a lint:configuration failure with the gate closed, like the CLI, and executes nothing", async (_label, buildCommands) => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
    const scripted = markerPath();
    const configured = markerPath();
    const repoPath = makeFixtureRepo("exit 0", {
      packageScripts: { lint: `touch ${scripted}` },
      extra: {
        checks: {
          gitState: false,
          lint: true,
          typecheck: false,
          test: false,
          audit: false,
          ciSimulation: false,
          commitConvention: false,
          secretDetection: false,
          tdd: false,
        },
        commands: buildCommands(configured),
      },
    });
    dirs.push(repoPath);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({ name: "preflight_run", arguments: { repoPath } });
      expect(response.isError).toBeFalsy();
      const structured = response.structuredContent as { ready: boolean; checks: RunChecks };
      expect(fs.existsSync(scripted)).toBe(false);
      expect(fs.existsSync(configured)).toBe(false);
      const lint = structured.checks.filter((c) => c.kind === "lint");
      expect(lint.map((c) => [c.name, c.status])).toEqual([["lint:configuration", "fail"]]);
      expect(structured.ready).toBe(false);
    } finally {
      await close();
    }
  });

  it("keeps the gate closed when the repo config also carries a config warning", async () => {
    vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
    const marker = markerPath();
    const repoPath = makeFixtureRepo(`touch ${marker}`, { extra: { surpriseKey: true } });
    dirs.push(repoPath);
    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({ name: "preflight_run", arguments: { repoPath } });
      const structured = response.structuredContent as { checks: RunChecks; limitations: string[] };
      expect(fs.existsSync(marker)).toBe(false);
      expect(structured.checks.find((c) => c.name === "fixture-check")?.status).toBe("skip");
      expect(structured.limitations.some((l) => l.includes("surpriseKey"))).toBe(true);
    } finally {
      await close();
    }
  });

  describe("preflight_batch", () => {
    function makeBatchRoot(command: string, extra?: Record<string, unknown>): string {
      const batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-gate-batch-"));
      dirs.push(batchRoot);
      const fixture = makeFixtureRepo(command, { extra });
      fs.renameSync(fixture, path.join(batchRoot, path.basename(fixture)));
      return batchRoot;
    }

    async function batchChecks(root: string): Promise<RunChecks> {
      const { client, close } = await connectedClient();
      try {
        const response = await client.callTool({ name: "preflight_batch", arguments: { root } });
        expect(response.isError).toBeFalsy();
        const structured = response.structuredContent as {
          results: Array<{ result: { checks: RunChecks } | null }>;
        };
        return structured.results[0].result!.checks;
      } finally {
        await close();
      }
    }

    it("skips the repo's shell commands by default (marker absent, entry skipped)", async () => {
      vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
      const marker = markerPath();
      const checks = await batchChecks(makeBatchRoot(`touch ${marker}`));

      expect(fs.existsSync(marker)).toBe(false);
      expect(checks.find((c) => c.name === "fixture-check")?.status).toBe("skip");
    });

    it("keeps the gate closed when the repo config also carries a config warning", async () => {
      vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "");
      const marker = markerPath();
      const checks = await batchChecks(makeBatchRoot(`touch ${marker}`, { surpriseKey: true }));

      expect(fs.existsSync(marker)).toBe(false);
      expect(checks.find((c) => c.name === "fixture-check")?.status).toBe("skip");
    });

    it("runs them when the value is exactly \"1\" (marker exists)", async () => {
      vi.stubEnv("PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS", "1");
      const marker = markerPath();
      const checks = await batchChecks(makeBatchRoot(`touch ${marker}`));

      expect(fs.existsSync(marker)).toBe(true);
      expect(checks.find((c) => c.name === "fixture-check")?.status).toBe("pass");
    });
  });
});
