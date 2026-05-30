// Solution-acceptance gate (v1, deterministic floor).
//
// Makes "done" earned rather than claimed: a verdict is derived from a real
// preflight run (test/build/lint/audit/secret exit codes), pinned to the git
// HEAD it was produced at, and written to a producer-owned marker that the
// solving agent's normal write path does not produce. The gate then passes
// only when a ready verdict exists at the *current* HEAD.
//
// Anti-hacking contract (see docs/solution-acceptance-gate.md):
//   1. Derived, not claimed  — `ready` comes from runPreflight's real results,
//      never from a caller flag.
//   2. Producer != solver    — only `preflight verdict` writes the marker; the
//      check set is taken from committed `.preflight.json`, not from CLI args,
//      so an agent cannot weaken the gate at call time.
//   3. HEAD-pinned           — any rework shifts HEAD and invalidates a green
//      verdict (the Goodhart-via-rework brake).
//   4. No stale green        — a not-ready run overwrites a prior green marker.
//
// Documented residual: a shell-capable agent could hand-forge the marker file.
// Closing that (signing / a harness-owned marker dir checked by a PreToolUse
// hook, mirroring understanding-gate's checkApprovalMarker) is the harness
// wiring follow-up; v1 proves the producer + HEAD-pinning + derive-from-results.

import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";

export interface Verdict {
  /** Caller-supplied identifier the gate is scoped to (e.g. a task id). */
  id: string;
  /** 40-hex git HEAD sha the verdict was produced at. */
  head: string;
  /** Derived from a real preflight run: true iff there were no blockers. */
  ready: boolean;
  /** Preflight confidence score (0.0 - 1.0). */
  confidence: number;
  /** Blocker messages from the run (empty when ready). */
  blockers: string[];
  /** ISO timestamp the verdict was recorded. */
  timestamp: string;
  /** agent-preflight version that produced the verdict. */
  preflightVersion: string;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  verdict: Verdict | null;
  currentHead: string | null;
}

/**
 * The producer-owned directory verdict markers live in. Resolution order:
 *   1. PREFLIGHT_VERDICT_DIR (explicit override; used by tests)
 *   2. $XDG_STATE_HOME/agent-preflight/verdicts
 *   3. ~/.local/state/agent-preflight/verdicts
 *
 * Deliberately outside the repo working tree so a verdict survives across
 * the repo's own state and is not something the agent edits as part of its
 * solution diff.
 */
export function verdictDir(): string {
  const override = process.env.PREFLIGHT_VERDICT_DIR;
  if (override && override.trim().length > 0) return override;
  const xdgState = process.env.XDG_STATE_HOME;
  const base =
    xdgState && xdgState.trim().length > 0
      ? xdgState
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "agent-preflight", "verdicts");
}

/**
 * Reduce a verdict id to a single safe path segment. Non-portable characters
 * collapse to `_`, and `path.basename` strips any residual separator so the
 * id can never escape `verdictDir()` (path-traversal guard). Empty / dot-only
 * ids are rejected.
 */
export function sanitizeVerdictId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const base = path.basename(cleaned);
  if (base === "" || base === "." || base === "..") {
    throw new Error(`invalid verdict id: ${JSON.stringify(id)}`);
  }
  return base;
}

export function verdictPath(id: string): string {
  return path.join(verdictDir(), `${sanitizeVerdictId(id)}.json`);
}

/**
 * Resolve the current committed git HEAD sha (40-hex), or null when it can't
 * be determined (not a git repo, no commits, git missing). The gate treats a
 * null HEAD as "cannot confirm at-HEAD" and denies.
 */
export async function getHeadSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Write (or overwrite) the producer-owned verdict marker. Returns its path. */
export function writeVerdict(verdict: Verdict): string {
  const target = verdictPath(verdict.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  return target;
}

/** Read the verdict marker for an id, or null when absent / unparseable. */
export function readVerdict(id: string): Verdict | null {
  try {
    const raw = fs.readFileSync(verdictPath(id), "utf8");
    const parsed = JSON.parse(raw) as Partial<Verdict>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.head !== "string" ||
      typeof parsed.ready !== "boolean"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      head: parsed.head,
      ready: parsed.ready,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      preflightVersion:
        typeof parsed.preflightVersion === "string" ? parsed.preflightVersion : "",
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate the gate for an id at the current HEAD. Passes only when a ready
 * verdict exists AND was produced at exactly `currentHead`.
 */
export function evaluateGate(id: string, currentHead: string | null): GateResult {
  const verdict = readVerdict(id);
  if (!verdict) {
    return {
      allowed: false,
      reason: `no verdict recorded for "${id}" — run: preflight verdict ${id}`,
      verdict: null,
      currentHead,
    };
  }
  if (!verdict.ready) {
    const why = verdict.blockers.length > 0 ? `: ${verdict.blockers.join("; ")}` : "";
    return {
      allowed: false,
      reason: `verdict for "${id}" is not ready${why} — fix and re-run: preflight verdict ${id}`,
      verdict,
      currentHead,
    };
  }
  if (currentHead === null) {
    return {
      allowed: false,
      reason: `cannot resolve current git HEAD to confirm the verdict for "${id}" is at HEAD`,
      verdict,
      currentHead,
    };
  }
  if (verdict.head !== currentHead) {
    return {
      allowed: false,
      reason: `stale verdict for "${id}": recorded at ${verdict.head.slice(0, 7)}, current HEAD ${currentHead.slice(0, 7)} — re-run: preflight verdict ${id}`,
      verdict,
      currentHead,
    };
  }
  return {
    allowed: true,
    reason: `verdict for "${id}" is ready at HEAD ${currentHead.slice(0, 7)} (confidence ${Math.round(verdict.confidence * 100)}%)`,
    verdict,
    currentHead,
  };
}
