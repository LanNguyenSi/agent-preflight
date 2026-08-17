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
 *  - rotation boundary: exactly 20 files survives untouched, 21 deletes
 *    precisely the single oldest one (pins MAX_LOG_FILES = 20)
 *  - write-failure degradation: an unwritable logDir falls back to the
 *    pre-existing details shape (no path line) without throwing
 *  - default logDir resolves under os.homedir() when not overridden
 *    (verified with os.homedir() mocked to a temp dir — never the real home)
 *  - filename collision resistance: the log filename embeds process.pid,
 *    and two failures of the same check at the identical millisecond
 *    (Date.now() mocked) still land in two distinct files
 *  - sanitizeLogFileName: a `../`-shaped check name cannot smuggle a path
 *    separator into the persisted log's location
 *  - large output: a several-megabyte failing `all` output round-trips
 *    through the synchronous write path without throwing
 *  - FAILURE_LINE_PATTERN precision: a bullet glyph glued to other text
 *    (no trailing whitespace) is excluded from the parsed failure lines
 *    but is still present verbatim in the persisted full-output log
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

describe("runShellCheck full-output logging — rotation boundary (MAX_LOG_FILES = 20)", () => {
  it("keeps all 20 files when exactly at the limit", async () => {
    const logDir = makeTempDir("preflight-fail-log-rotation-20-");
    for (let i = 0; i < 20; i += 1) {
      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: `boundary-${i}`,
        kind: "lint",
        command: catCommand([`failure number ${i}`], 1),
        weight: 0.1,
        failureMessage: "lint failed",
        logDir,
      });
      expect(result.check?.status).toBe("fail");
    }

    const entries = fs.readdirSync(logDir);
    expect(entries).toHaveLength(20);
    expect(entries.some((name) => name.startsWith("boundary-0-"))).toBe(true);
    expect(entries.some((name) => name.startsWith("boundary-19-"))).toBe(true);
  });

  it("deletes exactly the single oldest file once the limit is exceeded by one", async () => {
    const logDir = makeTempDir("preflight-fail-log-rotation-21-");
    for (let i = 0; i < 21; i += 1) {
      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: `boundary-${i}`,
        kind: "lint",
        command: catCommand([`failure number ${i}`], 1),
        weight: 0.1,
        failureMessage: "lint failed",
        logDir,
      });
      expect(result.check?.status).toBe("fail");
    }

    const entries = fs.readdirSync(logDir);
    expect(entries).toHaveLength(20);
    expect(entries.some((name) => name.startsWith("boundary-0-"))).toBe(false);
    expect(entries.some((name) => name.startsWith("boundary-1-"))).toBe(true);
    expect(entries.some((name) => name.startsWith("boundary-20-"))).toBe(true);
  });
});

describe("runShellCheck full-output logging — filename collision resistance", () => {
  it("embeds the current process id in the persisted log filename", async () => {
    const logDir = makeTempDir("preflight-fail-log-pid-");
    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "pid-check",
      kind: "lint",
      command: catCommand(["boom"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });

    const logPath = result.check?.details?.[0]?.replace(/^full output: /, "");
    expect(logPath).toBeDefined();
    expect(path.basename(logPath!)).toContain(`-${process.pid}-`);
  });

  it("does not collide two same-check failures at the identical millisecond", async () => {
    const logDir = makeTempDir("preflight-fail-log-collision-");
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);

    const first = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "same-ms-check",
      kind: "lint",
      command: catCommand(["first failure"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });
    const second = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "same-ms-check",
      kind: "lint",
      command: catCommand(["second failure"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });

    const firstLogPath = first.check?.details?.[0]?.replace(/^full output: /, "");
    const secondLogPath = second.check?.details?.[0]?.replace(/^full output: /, "");
    expect(firstLogPath).toBeDefined();
    expect(secondLogPath).toBeDefined();
    expect(firstLogPath).not.toBe(secondLogPath);
    expect(fs.readFileSync(firstLogPath!, "utf-8")).toContain("first failure");
    expect(fs.readFileSync(secondLogPath!, "utf-8")).toContain("second failure");
    // Both files survive under the same directory at the identical
    // millisecond timestamp — no overwrite, no data loss.
    expect(fs.readdirSync(logDir)).toHaveLength(2);
  });
});

describe("runShellCheck full-output logging — sanitizeLogFileName via traversal-shaped check names", () => {
  it("keeps the persisted log inside logDir even when the check name looks like a path traversal", async () => {
    const logDir = makeTempDir("preflight-fail-log-sanitize-");
    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "../../evil",
      kind: "lint",
      command: catCommand(["boom"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });

    const logPath = result.check?.details?.[0]?.replace(/^full output: /, "");
    expect(logPath).toBeDefined();
    // The file must land directly inside logDir as a single filename with
    // no path separator smuggled through from the check name (not two
    // directories up, not anywhere else).
    expect(path.dirname(logPath!)).toBe(logDir);
    expect(path.basename(logPath!)).not.toMatch(/[/\\]/);
    expect(fs.readdirSync(logDir)).toHaveLength(1);
  });

  it("keeps a Windows-style traversal-shaped check name inside logDir too", async () => {
    const logDir = makeTempDir("preflight-fail-log-sanitize-win-");
    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "..\\..\\evil",
      kind: "lint",
      command: catCommand(["boom"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });

    const logPath = result.check?.details?.[0]?.replace(/^full output: /, "");
    expect(logPath).toBeDefined();
    expect(path.dirname(logPath!)).toBe(logDir);
    expect(path.basename(logPath!)).not.toMatch(/[/\\]/);
  });
});

describe("runShellCheck full-output logging — large output (sync write path)", () => {
  it(
    "persists and parses a multi-megabyte failing output without throwing",
    async () => {
      const logDir = makeTempDir("preflight-fail-log-large-");
      // `yes | head` (rather than a single large `process.stdout.write()`
      // from Node followed by `process.exit()`) sidesteps Node's own
      // known stdout-truncation footgun: a large `write()` to a non-TTY
      // pipe can still be draining asynchronously when `process.exit()`
      // fires, silently cutting off the tail of the output (observed
      // empirically while writing this test — output landed at exactly
      // 65536 bytes, Node's pipe highWaterMark). `yes`/`head` are plain
      // blocking POSIX commands with no such race.
      const bigLine = "x".repeat(200);
      const command = `yes '${bigLine}' | head -n 20000; echo "FAIL large-output-check"; exit 1`;

      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: "large-output-check",
        kind: "test",
        command,
        weight: 0.2,
        failureMessage: "test failed",
        logDir,
        timeoutMs: 30_000,
      });

      expect(result.check?.status).toBe("fail");
      const details = result.check?.details;
      expect(details?.[0]).toMatch(/^full output: /);
      const logPath = details![0].replace(/^full output: /, "");
      expect(fs.existsSync(logPath)).toBe(true);
      // 200 chars * 20000 lines + newlines is ~4MB; comfortably over 3MB
      // rules out any silent truncation of the sync write.
      expect(fs.statSync(logPath).size).toBeGreaterThan(3_000_000);
      expect(details!.slice(1)).toEqual(["FAIL large-output-check"]);
    },
    20_000
  );
});

describe("runShellCheck full-output logging — bullet markers require trailing whitespace", () => {
  it("excludes a bare marker glyph glued to other text from the parsed failure lines", async () => {
    const logDir = makeTempDir("preflight-fail-log-marker-precision-");
    const outputLines = [
      "●noSpaceBullet: this is not a real jest marker",
      "FAIL  tests/x.test.ts > real failure",
      "● MyComponent › renders correctly",
    ];

    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "marker-precision",
      kind: "test",
      command: catCommand(outputLines, 1),
      weight: 0.2,
      failureMessage: "test failed",
      logDir,
    });

    const details = result.check?.details;
    expect(details).toBeDefined();
    expect(details!.slice(1)).toEqual([
      "FAIL  tests/x.test.ts > real failure",
      "● MyComponent › renders correctly",
    ]);

    // The glued-glyph line is excluded from the *parsed* set (see the
    // FAILURE_LINE_PATTERN precision-decision comment in
    // src/checks/shared.ts) but is still fully present in the persisted
    // full-output log — the precision decision never loses information.
    const logPath = details![0].replace(/^full output: /, "");
    expect(fs.readFileSync(logPath, "utf-8")).toContain("●noSpaceBullet");
  });
});
