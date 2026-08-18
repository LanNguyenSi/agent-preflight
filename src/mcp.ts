#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runPreflight } from "./runner.js";
import { runBatch } from "./batch.js";
import { VERSION } from "./version.js";
import type { PreflightConfig, PreflightResult, CheckResult } from "./types.js";
import type { BatchResult } from "./batch.js";

// Both tools return a `ready` (or per-repo `ready`) field. This exact sentence
// is pinned by tests/mcp.test.ts's schema test — removing or rewording it is
// a behavior change (a calling agent silently loses the "don't merge on
// ready:false" guidance), not a copy edit.
const READY_FALSE_WARNING =
  "ready:false means this PR will likely break CI; do not merge.";

// The target repo is not just data: `.preflight.json` can define shell
// commands (customChecks[].command; commands.lint/typecheck/test/audit)
// that runShellCheck (src/checks/shared.ts) executes via `execa("bash",
// ["-c", command], ...)`. Any caller who can point this tool at a repo can
// therefore get arbitrary shell execution on the machine running the MCP
// server. This exact sentence is pinned by tests/mcp.test.ts's schema test,
// same as READY_FALSE_WARNING above — removing or rewording it silently
// drops the security guidance, not just edits copy.
const SHELL_SURFACE_WARNING =
  "The target repo's .preflight.json can define shell commands this tool will execute (customChecks[].command, commands.lint/typecheck/test/audit); only point it at trusted repositories.";

// Mirrors CheckKind (src/types.ts) exactly. A z.string() here would let
// `kind` silently drift from CheckKind's literal union without the
// schema-drift guard below ever noticing (a plain string type is always
// "assignable" in both directions against a narrower union in one of the
// two checks, so the guard below is only as strict as this list is
// accurate) — keep this list in lockstep with CheckKind by hand.
const CHECK_KIND_VALUES = [
  "git-state",
  "lint",
  "typecheck",
  "test",
  "audit",
  "ci-simulation",
  "commit-convention",
  "secret-detection",
  "tdd",
  "custom",
] as const;

const checkResultOutputShape = {
  name: z.string(),
  kind: z.enum(CHECK_KIND_VALUES),
  // "acknowledged" (agent-tasks b31065cc): a check that failed but was
  // waived via checks.<kind>.acknowledge in .preflight.json. Mirrors
  // CheckResult["status"] (src/types.ts) exactly — the schema-drift guard
  // below fails typecheck if this list and that union ever diverge.
  status: z.enum(["pass", "fail", "warn", "skip", "acknowledged"]),
  message: z.string().optional(),
  details: z.array(z.string()).optional(),
  durationMs: z.number(),
  confidenceContribution: z.number(),
};

// Bare (no `.catchall`) zod objects mirroring CheckResult/PreflightResult/
// BatchResult (src/types.ts, src/batch.ts) field-for-field. These are the
// source of truth for the schema-drift guard below: TypeScript requires a
// type carrying a `.catchall()`-added index signature to itself declare a
// matching index signature to be assignable to/from a concrete interface
// like CheckResult, so a tolerant (catchall'd) shape can never pass a
// bidirectional check against these interfaces — see the runtime-tolerant
// section further down for why that tolerance still exists, just on
// separate objects.
const checkResultSchema = z.object(checkResultOutputShape);

const preflightResultOutputShape = {
  ready: z.boolean(),
  confidence: z.number(),
  checks: z.array(checkResultSchema),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  limitations: z.array(z.string()),
  durationMs: z.number(),
  timestamp: z.string(),
};
const preflightResultSchema = z.object(preflightResultOutputShape);

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
      result: preflightResultSchema.nullable(),
      error: z.string().optional(),
    })
  ),
};
const batchResultSchema = z.object(batchResultOutputShape);

// --- Schema-drift guard ---------------------------------------------------
// Compile-time-only assignability checks between the bare zod shapes above
// and the runner's real result types. If either side gains, loses, or
// retypes a field without a matching edit on the other, one of the
// assignments below stops typechecking and `npm run typecheck` goes red —
// instead of the MCP contract silently drifting from `preflight run --json`
// / `preflight batch --json` at runtime. Nothing here executes; `void`
// keeps these bindings from also tripping `@typescript-eslint/no-unused-vars`.
type PreflightResultInfer = z.infer<typeof preflightResultSchema>;
const _preflightResultAssignableToInfer: PreflightResultInfer = {} as PreflightResult;
const _inferAssignableToPreflightResult: PreflightResult = {} as PreflightResultInfer;
void _preflightResultAssignableToInfer;
void _inferAssignableToPreflightResult;

type CheckResultInfer = z.infer<typeof checkResultSchema>;
const _checkResultAssignableToInfer: CheckResultInfer = {} as CheckResult;
const _inferAssignableToCheckResult: CheckResult = {} as CheckResultInfer;
void _checkResultAssignableToInfer;
void _inferAssignableToCheckResult;

type BatchResultInfer = z.infer<typeof batchResultSchema>;
const _batchResultAssignableToInfer: BatchResultInfer = {} as BatchResult;
const _inferAssignableToBatchResult: BatchResult = {} as BatchResultInfer;
void _batchResultAssignableToInfer;
void _inferAssignableToBatchResult;

// --- Runtime-tolerant variants ---------------------------------------------
// Used only as the actual registerTool outputSchema arguments below, never
// for the drift guard above. `.catchall(z.unknown())` on the two
// runner-owned nested item schemas (CheckResult, and PreflightResult
// nested a level deeper inside a batch result) keeps a future field the
// runner adds to either type in the parsed structuredContent instead of
// the SDK's default z.object() behavior silently stripping it. The top
// level of each tool's own outputSchema (preflightRunOutputShape itself,
// and preflightBatchOutputShape itself) is intentionally left as a bare
// shape — the SDK controls how that outermost level gets wrapped, and
// mcp.test.ts's schema test already pins its exact key set.
const checkResultSchemaTolerant = checkResultSchema.catchall(z.unknown());
const preflightRunOutputShape = {
  ...preflightResultOutputShape,
  checks: z.array(checkResultSchemaTolerant),
};
const preflightResultSchemaTolerant = z.object(preflightRunOutputShape).catchall(z.unknown());
const preflightBatchOutputShape = {
  ...batchResultOutputShape,
  results: z.array(
    z.object({
      repo: z.string(),
      path: z.string(),
      result: preflightResultSchemaTolerant.nullable(),
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
        text: `${argName} is not an existing directory: ${resolvedPath}`,
      },
    ],
  };
}

// fs.existsSync(p) is true for files too, so pointing repoPath/root at a
// plain file previously fell through into runPreflight/runBatch and leaked
// a raw ENOTDIR from inside the check pipeline instead of this tool's own
// structured isError result. statSync with throwIfNoEntry:false returns
// undefined (not a throw) for a missing path, so a nonexistent path and an
// existing-but-not-a-directory path both cleanly resolve to `false` here.
function isExistingDirectory(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;

/**
 * The MCP SDK's default request timeout (DEFAULT_REQUEST_TIMEOUT_MSEC in
 * @modelcontextprotocol/sdk/shared/protocol) is 60s. preflight_run's shell
 * checks and preflight_batch's per-repo loop can easily run longer than
 * that on a real repo. Per the MCP spec, a client that wants to avoid
 * timing out a long-running call attaches a `progressToken` to the
 * request (`_meta.progressToken`) and resets its timeout on each
 * `notifications/progress` it receives; a client that didn't ask for
 * progress gets none ("the receiver is not obligated to provide these
 * notifications").
 *
 * This pings the client with a progress notification every `intervalMs`
 * while `work` is pending, IF the caller opted in via a progressToken —
 * otherwise it just awaits `work` unchanged. The interval is always
 * cleared before returning, on both the success and the throw path, so it
 * never outlives the tool call.
 *
 * `intervalMs` is a parameter (not a module-level constant) specifically
 * so tests can inject a short interval without touching global state (see
 * createMcpServer's `progressIntervalMs` option and tests/mcp.test.ts).
 */
async function withProgressPings<T>(
  extra: ToolExtra,
  work: () => Promise<T>,
  intervalMs: number = DEFAULT_PROGRESS_INTERVAL_MS
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return work();
  }

  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    // Best-effort ping: a transport hiccup or a closed connection must
    // never surface as an unhandled rejection from inside this interval
    // callback (which isn't awaited by anything and has no caller to
    // propagate to).
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: "agent-preflight checks still running",
        },
      })
      .catch(() => {});
  }, intervalMs);

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Builds a fresh McpServer with its tools registered, without connecting a
 * transport. Exported so tests can drive it over an in-memory transport
 * pair instead of real stdio (see tests/mcp.test.ts) — mirroring the
 * createProgram() test seam in src/cli.ts.
 *
 * `progressIntervalMs` overrides the default ~10s progress-ping cadence;
 * it exists so tests can use a short interval instead of waiting 10s for a
 * real tick (see the "progress notifications" describe block in
 * tests/mcp.test.ts). Production callers (startMcpServer) never set it.
 */
export function createMcpServer(options: { progressIntervalMs?: number } = {}): McpServer {
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;

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
        READY_FALSE_WARNING +
        " " +
        SHELL_SURFACE_WARNING,
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
      outputSchema: preflightRunOutputShape,
    },
    async ({ repoPath, ciSimulation, noAudit, noSecrets }, extra) => {
      const resolvedPath = path.resolve(repoPath);
      if (!isExistingDirectory(resolvedPath)) {
        return pathNotFoundError("repoPath", resolvedPath);
      }

      const config: PreflightConfig = loadConfig(resolvedPath);
      if (ciSimulation) config.checks = { ...config.checks, ciSimulation: true };
      if (noAudit) config.checks = { ...config.checks, audit: false };
      if (noSecrets) config.checks = { ...config.checks, secretDetection: false };

      const result = await withProgressPings(
        extra,
        () => runPreflight(resolvedPath, config),
        progressIntervalMs
      );

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
        READY_FALSE_WARNING +
        " " +
        SHELL_SURFACE_WARNING,
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
        noAudit: z
          .boolean()
          .optional()
          .describe("Skip the dependency audit check for every repo. Default false (audit runs)."),
        noSecrets: z
          .boolean()
          .optional()
          .describe("Skip secret detection for every repo. Default false (secret detection runs)."),
      },
      outputSchema: preflightBatchOutputShape,
    },
    async ({ root, only, exclude, noAudit, noSecrets }, extra) => {
      const resolvedRoot = path.resolve(root);
      if (!isExistingDirectory(resolvedRoot)) {
        return pathNotFoundError("root", resolvedRoot);
      }

      // Mirrors the CLI's `preflight batch` action (src/cli.ts): build a
      // configOverride and always pass it through to runBatch, even when
      // empty (mergeConfig(base, {}) is a no-op). `setup` is deliberately
      // NOT exposed here, unlike the CLI's `--setup`: it can run
      // dependency-bootstrap commands (npm ci, composer install, ...) that
      // mutate the target repo, a different risk profile from the
      // otherwise read-only checks this tool runs.
      const configOverride: Partial<PreflightConfig> = {};
      if (noAudit) configOverride.checks = { ...configOverride.checks, audit: false };
      if (noSecrets) configOverride.checks = { ...configOverride.checks, secretDetection: false };

      const batchResult = await withProgressPings(
        extra,
        () => runBatch(resolvedRoot, { only, exclude }, configOverride),
        progressIntervalMs
      );

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
