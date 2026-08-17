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
  // A constant check name (no per-iteration numeric suffix) plus tracking
  // each call's own returned log path is deliberate; see the identical
  // rationale in the "rotation boundary" describe block below: a
  // per-iteration name suffix can mask a naming-shape regression instead of
  // catching it, so correctness here is verified against real paths.
  it("keeps only the last 20 of this check's own log files and ignores foreign files", async () => {
    const logDir = makeTempDir("preflight-fail-log-rotation-");
    fs.mkdirSync(logDir, { recursive: true });
    const foreignFile = path.join(logDir, "not-ours.txt");
    fs.writeFileSync(foreignFile, "leave me alone");
    // Foreign files shaped like real logs from other tools that could share
    // this directory: an nginx-style dated access log (three dash-separated
    // number groups before `.log`, year, month, day) and a monthly backup
    // log (two groups, year, month). Neither group is an actual epoch-ms
    // timestamp, but a width-unbounded `\d+` in `OWN_LOG_FILE_PATTERN` /
    // `LEGACY_LOG_FILE_PATTERN` would still match the dash-number-count
    // shape alone and misclassify them as this feature's own files, which
    // then makes them eligible for silent deletion by rotation. Both must
    // survive untouched.
    const nginxForeignFile = path.join(logDir, "nginx-2026-08-17.log");
    fs.writeFileSync(nginxForeignFile, "not agent-preflight's log");
    const backupForeignFile = path.join(logDir, "backup-2026-08.log");
    fs.writeFileSync(backupForeignFile, "not agent-preflight's log either");

    const logPaths: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: "rotation-check",
        kind: "lint",
        command: catCommand([`failure number ${i}`], 1),
        weight: 0.1,
        failureMessage: "lint failed",
        logDir,
      });
      expect(result.check?.status).toBe("fail");
      logPaths.push(result.check!.details![0].replace(/^full output: /, ""));
    }

    const entries = fs.readdirSync(logDir);
    const ownFiles = entries.filter(
      (name) => name !== "not-ours.txt" && name !== "nginx-2026-08-17.log" && name !== "backup-2026-08.log"
    );
    expect(ownFiles).toHaveLength(20);
    expect(entries).toContain("not-ours.txt");
    expect(entries).toContain("nginx-2026-08-17.log");
    expect(entries).toContain("backup-2026-08.log");

    // The 5 oldest of the 25 real failures are rotated out, the 20 newest
    // survive; verified against the actual returned paths, not a
    // name-derived prefix.
    expect(fs.existsSync(logPaths[0])).toBe(false);
    expect(fs.existsSync(logPaths[4])).toBe(false);
    expect(fs.existsSync(logPaths[5])).toBe(true);
    expect(fs.existsSync(logPaths[24])).toBe(true);
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

describe("runShellCheck full-output logging — rotation sorts by the filename key, not mtime", () => {
  it("deletes the name-key-oldest file even when its mtime is the newest on disk", async () => {
    const logDir = makeTempDir("preflight-fail-log-name-key-sort-");
    const baseEpoch = 1_700_000_000_000;
    const now = new Date();

    // Seed exactly MAX_LOG_FILES (20) files whose *names* are in ascending
    // chronological order (i=0 oldest by name-key, i=19 newest), but whose
    // *mtimes* are deliberately set in the opposite order: i=0 gets the
    // newest mtime, i=19 gets the oldest. If rotation ever regresses back
    // to sorting by statSync mtime, it would delete i=19 (oldest mtime)
    // instead of i=0 (oldest name-key) once the 21st file pushes it over
    // the limit below.
    for (let i = 0; i < 20; i += 1) {
      const fileName = `seed-${baseEpoch + i}-1-1.log`;
      fs.writeFileSync(path.join(logDir, fileName), `seed file ${i}`);
      const mtime = new Date(now.getTime() - i * 60_000); // i=0 newest, i=19 oldest
      fs.utimesSync(path.join(logDir, fileName), mtime, mtime);
    }

    // Push the count to 21 so rotation deletes exactly one file.
    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "seed-trigger",
      kind: "lint",
      command: catCommand(["trigger rotation"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });
    expect(result.check?.status).toBe("fail");

    const entries = fs.readdirSync(logDir);
    expect(entries).toHaveLength(20);
    // Name-key-oldest (i=0, despite having the newest mtime) is gone.
    expect(entries).not.toContain(`seed-${baseEpoch + 0}-1-1.log`);
    // Name-key-newest of the seeded batch (i=19, despite having the
    // oldest mtime) survives.
    expect(entries).toContain(`seed-${baseEpoch + 19}-1-1.log`);
  });
});

describe("runShellCheck full-output logging — rotation boundary (MAX_LOG_FILES = 20)", () => {
  // A constant check name (no per-iteration numeric suffix) is deliberate:
  // an earlier version of these tests used `boundary-${i}` as the check
  // name and asserted on a `boundary-<i>-` filename prefix. That is a weak
  // pin — with a per-iteration digit suffix baked into the check name, a
  // mutant that drops the pid segment from the persisted filename (reverting
  // `persistFailureOutput` to the pre-016425e6 `<name>-<epoch>-<seq>.log`
  // shape) still produces a filename with three dash-separated number groups
  // before `.log` (the trailing digit of e.g. "boundary-0" supplies the
  // spurious third one), so `OWN_LOG_FILE_PATTERN` kept matching and
  // rotation kept "working" — for the wrong reason, since the resulting sort
  // key was reading the check-name digit as the epoch. Using one constant
  // name per test and tracking each call's own returned log path removes
  // that accidental masking: rotation correctness is verified against real
  // paths, not a name-derived prefix.
  it("keeps all 20 files when exactly at the limit", async () => {
    const logDir = makeTempDir("preflight-fail-log-rotation-20-");
    const logPaths: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: "boundaryN",
        kind: "lint",
        command: catCommand([`failure number ${i}`], 1),
        weight: 0.1,
        failureMessage: "lint failed",
        logDir,
      });
      expect(result.check?.status).toBe("fail");
      logPaths.push(result.check!.details![0].replace(/^full output: /, ""));
    }

    const entries = fs.readdirSync(logDir);
    expect(entries).toHaveLength(20);
    expect(fs.existsSync(logPaths[0])).toBe(true);
    expect(fs.existsSync(logPaths[19])).toBe(true);
  });

  it("deletes exactly the single oldest file once the limit is exceeded by one", async () => {
    const logDir = makeTempDir("preflight-fail-log-rotation-21-");
    const logPaths: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const result = await runShellCheck({
        repoPath: os.tmpdir(),
        name: "boundaryN",
        kind: "lint",
        command: catCommand([`failure number ${i}`], 1),
        weight: 0.1,
        failureMessage: "lint failed",
        logDir,
      });
      expect(result.check?.status).toBe("fail");
      logPaths.push(result.check!.details![0].replace(/^full output: /, ""));
    }

    const entries = fs.readdirSync(logDir);
    expect(entries).toHaveLength(20);
    expect(fs.existsSync(logPaths[0])).toBe(false);
    expect(fs.existsSync(logPaths[1])).toBe(true);
    expect(fs.existsSync(logPaths[20])).toBe(true);
  });
});

describe("runShellCheck full-output logging — legacy pre-pid filenames are drained, not orphaned", () => {
  it("counts legacy `<check>-<epoch>-<seq>.log` files in the same rotation pass as current-format files and deletes the oldest across both shapes", async () => {
    const logDir = makeTempDir("preflight-fail-log-legacy-drain-");
    const baseEpoch = 1_700_000_000_000;

    // Seed 15 legacy-format files (no pid segment — the shape written by
    // agent-preflight <0.4.0) as the oldest 15, and 5 current-format files
    // as the newest 5. Total = 20, exactly at MAX_LOG_FILES, so nothing
    // should be deleted yet.
    for (let i = 0; i < 15; i += 1) {
      const fileName = `legacy-check-${baseEpoch + i}-1.log`;
      fs.writeFileSync(path.join(logDir, fileName), `legacy seed ${i}`);
    }
    for (let i = 0; i < 5; i += 1) {
      const fileName = `legacy-check-${baseEpoch + 1000 + i}-1-1.log`;
      fs.writeFileSync(path.join(logDir, fileName), `current seed ${i}`);
    }
    expect(fs.readdirSync(logDir)).toHaveLength(20);

    // One more real failure pushes the count to 21. If legacy files were
    // still orphaned (the pre-fix bug), rotation would only ever see the 5
    // current-format seed files, conclude it is well under the 20-file cap,
    // and delete nothing — the directory would grow to 21 files and keep
    // growing forever after. With the fix, all 20 seeded files (legacy +
    // current) plus the new one are counted together, and the single
    // oldest — a legacy file, since all legacy seeds predate all current
    // seeds — is deleted.
    const result = await runShellCheck({
      repoPath: os.tmpdir(),
      name: "legacy-check",
      kind: "lint",
      command: catCommand(["trigger rotation"], 1),
      weight: 0.1,
      failureMessage: "lint failed",
      logDir,
    });
    expect(result.check?.status).toBe("fail");

    const entries = fs.readdirSync(logDir);
    expect(entries).toHaveLength(20);
    // The oldest legacy file (i=0) is gone…
    expect(entries).not.toContain(`legacy-check-${baseEpoch + 0}-1.log`);
    // …but later legacy files and all current-format seeds survive: the
    // legacy batch drained from its own oldest end, mixed in by timestamp
    // with the current-format batch, not wholesale ignored or wholesale
    // wiped.
    expect(entries).toContain(`legacy-check-${baseEpoch + 14}-1.log`);
    for (let i = 0; i < 5; i += 1) {
      expect(entries).toContain(`legacy-check-${baseEpoch + 1000 + i}-1-1.log`);
    }
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
