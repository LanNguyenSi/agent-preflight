import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";

// Connects a fresh createMcpServer() instance to a fresh SDK Client over a
// linked in-memory transport pair — the in-process stand-in for a real
// `claude mcp add` registration (which needs a session restart to dogfood
// for real; see the task's "Pflicht-Verifikation" note).
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
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
function makeFixtureRepo(customCommand: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mcp-fixture-"));
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" })
  );
  fs.writeFileSync(
    path.join(repoPath, ".preflight.json"),
    JSON.stringify({
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
      customChecks: [{ name: "fixture-check", command: customCommand }],
      logDir: "custom-logs",
    })
  );
  execSync("git init", { cwd: repoPath });
  execSync('git config user.email "test@example.com"', { cwd: repoPath });
  execSync('git config user.name "Test User"', { cwd: repoPath });
  execSync("git add .", { cwd: repoPath });
  execSync('git commit -m "chore: fixture"', { cwd: repoPath });
  return repoPath;
}

describe("MCP tool schema / registration", () => {
  it("lists preflight_run and preflight_batch with the ready:false warning pinned in both descriptions", async () => {
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
      const warning = "ready:false means this PR will likely break CI; do not merge.";
      expect(run.description).toContain(warning);
      expect(batch.description).toContain(warning);

      expect(Object.keys(run.inputSchema.properties ?? {}).sort()).toEqual(
        ["ciSimulation", "noAudit", "noSecrets", "repoPath"].sort()
      );
      expect(Object.keys(batch.inputSchema.properties ?? {}).sort()).toEqual(
        ["exclude", "only", "root"].sort()
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

      // noAudit/noSecrets must actually thread through to the runner, not
      // just be accepted and ignored.
      expect(
        (structured.checks as Array<{ kind: string }>).some((c) => c.kind === "audit")
      ).toBe(false);
      expect(
        (structured.checks as Array<{ kind: string }>).some((c) => c.kind === "secret-detection")
      ).toBe(false);

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
