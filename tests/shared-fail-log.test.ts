/**
 * Tests for the full-output-log + failure-line-parsing behavior added to
 * `runShellCheck` in src/checks/shared.ts.
 *
 * Covers (real execa, no mocking — see shared-fail-log-catch.test.ts for the
 * synchronous-spawn-throw / catch-branch scenario, which requires mocking
 * execa):
 *  - vitest-like red output: full log written, details = [full output line,
 *    ...parsed FAIL/×/❯ lines]
 *  - jest-like red output: details = [full output line, ...parsed FAIL/●
 *    lines]
 *  - fallback: red output with no recognizable failure-line markers falls
 *    back to the pre-existing first-10-non-empty-lines behavior (after the
 *    path line)
 *  - green run: no log file written, details undefined (unchanged from
 *    before this feature)
 *  - rotation: only the last 20 of this check's own log files survive;
 *    foreign files in the same directory are left alone
 *  - write-failure degradation: an unwritable logDir falls back to the
 *    pre-existing details shape (no path line) without throwing
 *  - default logDir resolves under os.homedir() when not overridden
 *    (verified with os.homedir() mocked to a temp dir — never the real home)
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runShellCheck } from "../src/checks/shared.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function catCommand(lines: string[], exitCode: number): string {
  // Emits `lines` verbatim via a heredoc, then exits with `exitCode`. Using
  // a heredoc (rather than many `echo` calls) keeps exotic characters like
  // "×", "✗", "❯", "●" intact without additional shell-escaping.
  return `cat <<'PREFLIGHT_EOF'\n${lines.join("\n")}\nPREFLIGHT_EOF\nexit ${exitCode}`;
}

describe("runShellCheck full-output logging — vitest-style red output", () => {
  it("writes the complete output to a log file and parses FAIL/×/❯ lines into details", async () => {
    const logDir = makeTempDir("preflight-fail-log-vitest-");
    const outputLines = [
      " ❯ tests/profiles.test.ts (12 tests | 2 failed) 8026ms",
      "     × does not run setup steps unless explicitly enabled 1309ms",
      "     × resolves workingDir before running checks 117ms",
      "",
      " FAIL  tests/profiles.test.ts > profile configuration > does not run setup steps unless explicitly enabled",
      "AssertionError: expected 'pass' to be 'fail'",
    ];

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "vitest-red",
      kind: "test",
      command: catCommand(outputLines, 1),
      weight: 0.2,
      failureMessage: "test failed",
      logDir,
    });

    expect(result.check?.status).toBe("fail");
    const details = result.check?.details;
    expect(details).toBeDefined();
    expect(details?.[0]).toMatch(/^full output: /);

    const logPath = details![0].replace(/^full output: /, "");
    expect(fs.existsSync(logPath)).toBe(true);
    expect(path.dirname(logPath)).toBe(logDir);
    const fileContent = fs.readFileSync(logPath, "utf-8");
    for (const line of outputLines) {
      if (line) expect(fileContent).toContain(line);
    }

    // Parsed failure lines: only the FAIL/×/❯ lines, trimmed, in order.
    expect(details!.slice(1)).toEqual([
      "❯ tests/profiles.test.ts (12 tests | 2 failed) 8026ms",
      "× does not run setup steps unless explicitly enabled 1309ms",
      "× resolves workingDir before running checks 117ms",
      "FAIL  tests/profiles.test.ts > profile configuration > does not run setup steps unless explicitly enabled",
    ]);
  });
});

describe("runShellCheck full-output logging — jest-style red output", () => {
  it("parses FAIL and ● lines into details", async () => {
    const logDir = makeTempDir("preflight-fail-log-jest-");
    const outputLines = [
      "FAIL src/foo.test.js",
      "  ● MyComponent › renders correctly",
      "",
      "    Expected: \"a\"",
      "    Received: \"b\"",
      "",
      "Test Suites: 1 failed, 1 total",
    ];

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "jest-red",
      kind: "test",
      command: catCommand(outputLines, 1),
      weight: 0.2,
      failureMessage: "test failed",
      logDir,
    });

    expect(result.check?.status).toBe("fail");
    const details = result.check?.details;
    expect(details?.[0]).toMatch(/^full output: /);
    expect(details!.slice(1)).toEqual(["FAIL src/foo.test.js", "● MyComponent › renders correctly"]);
  });
});

describe("runShellCheck full-output logging — fallback with no recognizable failure lines", () => {
  it("falls back to the first-10-non-empty-lines behavior after the path line", async () => {
    const logDir = makeTempDir("preflight-fail-log-fallback-");
    const outputLines = ["some random compiler error", "line 2 of the error", "line 3 of the error"];

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "generic-red",
      kind: "lint",
      command: catCommand(outputLines, 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });

    expect(result.check?.status).toBe("fail");
    const details = result.check?.details;
    expect(details?.[0]).toMatch(/^full output: /);
    expect(details!.slice(1)).toEqual(outputLines);
  });
});

describe("runShellCheck full-output logging — green run", () => {
  it("writes no log file and leaves details undefined", async () => {
    const logDir = makeTempDir("preflight-fail-log-green-");

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "green-check",
      kind: "lint",
      command: "echo all good",
      weight: 0.1,
      failureMessage: "should not fire",
      logDir,
    });

    expect(result.check?.status).toBe("pass");
    expect(result.check?.message).toBeUndefined();
    expect(result.check?.details).toBeUndefined();
    // makeTempDir() itself creates logDir (mkdtempSync), but runShellCheck
    // must never write a log file into it on the pass path.
    expect(fs.readdirSync(logDir)).toHaveLength(0);
  });
});

describe("runShellCheck full-output logging — rotation", () => {
  it("keeps only the last 20 of this check's own log files and ignores foreign files", async () => {
    const logDir = makeTempDir("preflight-fail-log-rotation-");
    fs.mkdirSync(logDir, { recursive: true });
    const foreignFile = path.join(logDir, "not-ours.txt");
    fs.writeFileSync(foreignFile, "leave me alone");

    for (let i = 0; i < 25; i += 1) {
      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: `check-${i}`,
        kind: "lint",
        command: catCommand([`failure number ${i}`], 1),
        weight: 0.1,
        failureMessage: "lint failed",
        logDir,
      });
      expect(result.check?.status).toBe("fail");
    }

    const entries = fs.readdirSync(logDir);
    const ownFiles = entries.filter((name) => name !== "not-ours.txt");
    expect(ownFiles).toHaveLength(20);
    expect(entries).toContain("not-ours.txt");

    expect(ownFiles.some((name) => name.startsWith("check-0-"))).toBe(false);
    expect(ownFiles.some((name) => name.startsWith("check-24-"))).toBe(true);
  });
});

describe("runShellCheck full-output logging — write failure degrades gracefully", () => {
  it("falls back to details without a path line when logDir cannot be created, and never throws", async () => {
    const parentDir = makeTempDir("preflight-fail-log-writefail-");
    const blockingFile = path.join(parentDir, "blocking-file");
    fs.writeFileSync(blockingFile, "i am a file, not a directory");
    // Attempting to mkdir -p through a path segment that is a regular file
    // must throw ENOTDIR — this is the unwritable-logDir scenario.
    const unwritableLogDir = path.join(blockingFile, "logs");

    const outputLines = ["some failure output"];
    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "unwritable-log",
      kind: "lint",
      command: catCommand(outputLines, 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir: unwritableLogDir,
    });

    expect(result.check?.status).toBe("fail");
    expect(result.check?.details).toEqual(outputLines);
    expect(result.check?.details?.[0]).not.toMatch(/^full output: /);
  });
});

describe("runShellCheck full-output logging — default logDir", () => {
  it("resolves under os.homedir()/.agent-preflight/logs when not overridden", async () => {
    const fakeHome = makeTempDir("preflight-fail-log-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "default-logdir-check",
      kind: "lint",
      command: catCommand(["boom"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      // logDir intentionally omitted — exercise the default.
    });

    expect(result.check?.status).toBe("fail");
    const logPath = result.check?.details?.[0]?.replace(/^full output: /, "");
    expect(logPath).toBeDefined();
    expect(logPath).toBe(path.join(fakeHome, ".agent-preflight", "logs", path.basename(logPath!)));
    expect(fs.existsSync(logPath!)).toBe(true);
  });
});
