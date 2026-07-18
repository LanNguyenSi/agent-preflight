/**
 * Tests for the full-output-log + failure-line-parsing behavior in the
 * `catch` branch of `runShellCheck` (src/checks/shared.ts) — i.e. when the
 * underlying execa() call rejects rather than resolving with a non-zero
 * exitCode.
 *
 * With `reject: false` (as runShellCheck passes), execa only ever rejects
 * when the child_process.spawn() call itself throws synchronously (see
 * node_modules/execa/index.js), which in practice only happens for a
 * genuinely missing `bash` binary or similar OS-level spawn failure — not
 * reproducible portably by manipulating PATH. So, matching the existing
 * `tests/ci.test.ts` pattern, execa is mocked here to force that branch.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockExeca = vi.hoisted(() => vi.fn());

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return { ...actual, execa: mockExeca };
});

import { runShellCheck } from "../src/checks/shared.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runShellCheck full-output logging — catch branch", () => {
  it("persists the full output and parses failure lines when execa() rejects", async () => {
    const logDir = makeTempDir("preflight-fail-log-catch-");
    const outputLines = ["FAIL src/foo.test.js", "  ● MyComponent › renders correctly"];
    const error = Object.assign(new Error("boom"), { all: outputLines.join("\n") });
    mockExeca.mockRejectedValue(error);

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "catch-branch-check",
      kind: "test",
      command: "irrelevant-because-execa-is-mocked",
      weight: 0.1,
      failureMessage: "test failed",
      logDir,
    });

    expect(result.check?.status).toBe("fail");
    expect(result.check?.message).toBe("test failed: boom");

    const details = result.check?.details;
    expect(details?.[0]).toMatch(/^full output: /);
    const logPath = details![0].replace(/^full output: /, "");
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("FAIL src/foo.test.js");
    expect(details!.slice(1)).toEqual(["FAIL src/foo.test.js", "● MyComponent › renders correctly"]);
  });

  it("still returns the limitation (not a log-backed fail) for a TOCTOU ENOENT with missingLimitation set", async () => {
    // Preexisting contract, unaffected by the logging feature: the
    // `commandExists` pre-check reports the binary present (simulating the
    // ordinary case), but the actual spawn then throws ENOENT (e.g. a race
    // where the binary disappears between the pre-check and the real
    // invocation). This must still short-circuit to a limitation and must
    // never touch the log path.
    const logDir = makeTempDir("preflight-fail-log-catch-enoent-");
    const error = Object.assign(new Error("spawn xyz ENOENT"), { code: "ENOENT" });
    mockExeca.mockImplementation(async (_file: unknown, args: unknown) => {
      if (Array.isArray(args) && args.some((a) => typeof a === "string" && a.includes("command -v"))) {
        // The commandExists() pre-check: report the binary as present.
        return { exitCode: 0 };
      }
      throw error;
    });

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "catch-branch-enoent",
      kind: "test",
      command: "irrelevant-because-execa-is-mocked",
      weight: 0.1,
      failureMessage: "test failed",
      missingLimitation: "tool not installed; skipped",
      logDir,
    });

    expect(result.limitation).toBe("tool not installed; skipped");
    expect(result.check).toBeUndefined();
    expect(fs.readdirSync(logDir)).toHaveLength(0);
  });
});
