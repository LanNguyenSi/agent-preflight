#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runPreflight } from "./runner.js";
import { runBatch } from "./batch.js";
import { VERSION } from "./version.js";
import type { PreflightConfig } from "./types.js";

// Both tools return a `ready` (or per-repo `ready`) field. This exact sentence
// is pinned by tests/mcp.test.ts's schema test — removing or rewording it is
// a behavior change (a calling agent silently loses the "don't merge on
// ready:false" guidance), not a copy edit.
const READY_FALSE_WARNING =
  "ready:false means this PR will likely break CI; do not merge.";

const checkResultOutputShape = {
  name: z.string(),
  kind: z.string(),
  status: z.enum(["pass", "fail", "warn", "skip"]),
  message: z.string().optional(),
  details: z.array(z.string()).optional(),
  durationMs: z.number(),
  confidenceContribution: z.number(),
};

// Mirrors PreflightResult (src/types.ts) field-for-field so preflight_run's
// structuredContent is exactly `preflight run --json`'s output shape.
const preflightResultOutputShape = {
  ready: z.boolean(),
  confidence: z.number(),
  checks: z.array(z.object(checkResultOutputShape)),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  limitations: z.array(z.string()),
  durationMs: z.number(),
  timestamp: z.string(),
};

// Mirrors BatchResult (src/batch.ts).
const batchResultOutputShape = {
  root: z.string(),
  total: z.number(),
  ready: z.number(),
  notReady: z.number(),
  skipped: z.number(),
  results: z.array(
    z.object({
      repo: z.string(),
      path: z.string(),
      result: z.object(preflightResultOutputShape).nullable(),
      error: z.string().optional(),
    })
  ),
};

type ToolErrorResult = { isError: true; content: [{ type: "text"; text: string }] };

function pathNotFoundError(argName: string, resolvedPath: string): ToolErrorResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${argName} does not exist: ${resolvedPath}`,
      },
    ],
  };
}

/**
 * Builds a fresh McpServer with its tools registered, without connecting a
 * transport. Exported so tests can drive it over an in-memory transport
 * pair instead of real stdio (see tests/mcp.test.ts) — mirroring the
 * createProgram() test seam in src/cli.ts.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-preflight",
    version: VERSION,
  });

  server.registerTool(
    "preflight_run",
    {
      title: "Run preflight checks",
      description:
        "Run agent-preflight's local CI checks (lint, typecheck, test, dependency audit, " +
        "secret detection, commit convention, git state, and more) against a single " +
        "repository. Returns the exact structured result `preflight run --json` produces: " +
        "ready, confidence, checks, blockers, warnings, limitations. " +
        READY_FALSE_WARNING,
      inputSchema: {
        repoPath: z
          .string()
          .describe("Absolute or relative path to the repository to check."),
        ciSimulation: z
          .boolean()
          .optional()
          .describe(
            "Enable act-based CI simulation (requires the `act` CLI to be installed). Default false."
          ),
        noAudit: z
          .boolean()
          .optional()
          .describe("Skip the dependency audit check. Default false (audit runs)."),
        noSecrets: z
          .boolean()
          .optional()
          .describe("Skip secret detection. Default false (secret detection runs)."),
      },
      outputSchema: preflightResultOutputShape,
    },
    async ({ repoPath, ciSimulation, noAudit, noSecrets }) => {
      const resolvedPath = path.resolve(repoPath);
      if (!fs.existsSync(resolvedPath)) {
        return pathNotFoundError("repoPath", resolvedPath);
      }

      const config: PreflightConfig = loadConfig(resolvedPath);
      if (ciSimulation) config.checks = { ...config.checks, ciSimulation: true };
      if (noAudit) config.checks = { ...config.checks, audit: false };
      if (noSecrets) config.checks = { ...config.checks, secretDetection: false };

      const result = await runPreflight(resolvedPath, config);

      return {
        // Spread: PreflightResult has no index signature, but
        // structuredContent is typed as Record<string, unknown>.
        structuredContent: { ...result },
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "preflight_batch",
    {
      title: "Run preflight across a directory of repos",
      description:
        "Run agent-preflight across every git repository directly under `root` " +
        "(non-recursive, one level deep). Returns the exact structured result " +
        "`preflight batch --json` produces: per-repo ready/confidence/blockers plus " +
        "aggregate ready/notReady/skipped counts. " +
        READY_FALSE_WARNING,
      inputSchema: {
        root: z
          .string()
          .describe("Absolute or relative path to the directory containing the repos to check."),
        only: z
          .string()
          .optional()
          .describe("Only include repos whose directory name matches this glob (e.g. 'frost-*')."),
        exclude: z
          .string()
          .optional()
          .describe("Exclude repos whose directory name matches this glob."),
      },
      outputSchema: batchResultOutputShape,
    },
    async ({ root, only, exclude }) => {
      const resolvedRoot = path.resolve(root);
      if (!fs.existsSync(resolvedRoot)) {
        return pathNotFoundError("root", resolvedRoot);
      }

      const batchResult = await runBatch(resolvedRoot, { only, exclude });

      return {
        structuredContent: { ...batchResult },
        content: [{ type: "text" as const, text: JSON.stringify(batchResult, null, 2) }],
      };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// require.main === module is the same CommonJS entry-point idiom src/cli.ts
// uses: true only when this file is the Node.js entry point
// (node dist/mcp.js / the `preflight-mcp` bin), false when imported by
// tests or other modules.
if (require.main === module) {
  startMcpServer().catch((err) => {
    console.error("agent-preflight MCP server failed:", err);
    process.exit(1);
  });
}
