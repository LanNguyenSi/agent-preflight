import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateGate,
  readVerdict,
  sanitizeVerdictId,
  verdictDir,
  verdictPath,
  writeVerdict,
  type Verdict,
} from "../src/verdict";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: "task-1",
    head: HEAD_A,
    ready: true,
    confidence: 0.9,
    blockers: [],
    timestamp: "2026-05-30T00:00:00.000Z",
    preflightVersion: "0.0.0-test",
    ...over,
  };
}

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.PREFLIGHT_VERDICT_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-verdict-"));
  process.env.PREFLIGHT_VERDICT_DIR = tmpDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PREFLIGHT_VERDICT_DIR;
  else process.env.PREFLIGHT_VERDICT_DIR = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("sanitizeVerdictId", () => {
  it("keeps a clean id intact", () => {
    expect(sanitizeVerdictId("task-123_v2.1")).toBe("task-123_v2.1");
  });

  it("collapses a path-traversal id to a single safe segment inside verdictDir", () => {
    const id = "../../etc/passwd";
    const seg = sanitizeVerdictId(id);
    expect(seg).not.toContain("/");
    expect(seg).not.toContain(path.sep);
    // The marker path can never escape verdictDir.
    expect(path.dirname(verdictPath(id))).toBe(verdictDir());
  });

  it("rejects empty / dot-only ids", () => {
    expect(() => sanitizeVerdictId("")).toThrow();
    expect(() => sanitizeVerdictId(".")).toThrow();
    expect(() => sanitizeVerdictId("..")).toThrow();
    expect(() => sanitizeVerdictId("/")).not.toThrow(); // "/" -> "_" -> valid segment
  });
});

describe("writeVerdict / readVerdict", () => {
  it("round-trips a verdict", () => {
    const v = makeVerdict();
    const p = writeVerdict(v);
    expect(fs.existsSync(p)).toBe(true);
    expect(readVerdict(v.id)).toEqual(v);
  });

  it("returns null for a missing verdict", () => {
    expect(readVerdict("never-written")).toBeNull();
  });

  it("returns null for a corrupt marker", () => {
    const v = makeVerdict();
    fs.mkdirSync(verdictDir(), { recursive: true });
    fs.writeFileSync(verdictPath(v.id), "{ not json", "utf8");
    expect(readVerdict(v.id)).toBeNull();
  });
});

describe("evaluateGate", () => {
  it("PASSES when a ready verdict exists at the current HEAD", () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    const r = evaluateGate("task-1", HEAD_A);
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain("ready at HEAD");
  });

  it("DENIES when no verdict was recorded", () => {
    const r = evaluateGate("task-1", HEAD_A);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("no verdict recorded");
  });

  it("DENIES a not-ready verdict and surfaces the blockers", () => {
    writeVerdict(
      makeVerdict({ ready: false, blockers: ["test: 2 failing", "lint: 1 error"] }),
    );
    const r = evaluateGate("task-1", HEAD_A);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not ready");
    expect(r.reason).toContain("test: 2 failing");
  });

  it("DENIES a stale verdict on HEAD drift (Goodhart-via-rework brake)", () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    const r = evaluateGate("task-1", HEAD_B);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("stale verdict");
    expect(r.reason).toContain(HEAD_A.slice(0, 7));
    expect(r.reason).toContain(HEAD_B.slice(0, 7));
  });

  it("DENIES when the current HEAD cannot be resolved", () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    const r = evaluateGate("task-1", null);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("cannot resolve current git HEAD");
  });
});

describe("no stale green", () => {
  it("a not-ready re-run overwrites a prior green verdict at the same HEAD", () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    expect(evaluateGate("task-1", HEAD_A).allowed).toBe(true);

    // Same id, same HEAD, but the solution regressed: re-running records red.
    writeVerdict(makeVerdict({ ready: false, head: HEAD_A, blockers: ["test: regressed"] }));
    const r = evaluateGate("task-1", HEAD_A);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not ready");
  });
});
