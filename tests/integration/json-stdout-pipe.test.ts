/**
 * Task 0089e6f5: `preflight run --json` (and, since round 2, `preflight batch
 * --json`) write the full result envelope with a single
 * `console.log`/`process.stdout.write` call and used to call `process.exit`
 * immediately afterwards. Piping stdout is asynchronous: a payload bigger
 * than the OS pipe buffer (commonly 64 KB / 65536 bytes on both Linux and
 * macOS, confirmed by direct measurement against this machine) only has its
 * first chunk copied into the kernel synchronously, and an immediate
 * `process.exit` tears the process down before the remainder is ever
 * written: a reader on the other end of a real pipe sees a cut-off,
 * unparseable JSON document, even though the exact same payload written to a
 * regular file (no pipe-buffer limit) comes through complete.
 *
 * This spawns the REAL built CLI binary (dist/cli.js, built fresh in a
 * top-level beforeAll here because the CI workflow's test job runs `npx
 * vitest run --coverage` with no preceding `npm run build`, so this file
 * builds dist/ in its own beforeAll) with a genuinely piped stdout
 * (child_process.spawn's `stdio: ["ignore", "pipe", ...]`, never a TTY)
 * against a fixture whose own failing test output is large enough to
 * reliably exceed that buffer.
 *
 * The T-008 pathological-path-token fixture (single-package-pathological-
 * path-token, 30000 segments) was measured directly and does NOT reproduce
 * this: its full `--json` envelope is ~62-63 KB, under the 65536-byte pipe
 * buffer on this repo's dev/CI platforms, so it never actually exercises the
 * pipe-write race this fix addresses. This dedicated, larger fixture
 * (single-package-json-stdout-overflow) does; see its own file for why it
 * uses `process.exitCode` rather than `process.exit()` internally (the same
 * truncation race, one process down, would otherwise cap ITS OWN captured
 * output regardless of how large the token is made).
 *
 * A real EPIPE (the reader closing the pipe before the write completes) is
 * also exercised end to end here (round 2, review of task 0089e6f5): the
 * child's own stdout read end is destroyed immediately after spawn, which is
 * deterministic in practice (measured 10/10 over repeated local runs on
 * macOS / Node 26) because Node's pipe write only completes asynchronously,
 * giving the parent time to close its end first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");
const FIXTURE_NAME = "single-package-json-stdout-overflow";
const FIXTURES_ROOT = path.join(__dirname, "..", "fixtures");

// The OS pipe buffer this fix is racing against; used only to assert this
// fixture's output is actually big enough to be a meaningful test, not as
// part of the pass/fail contract itself (a smaller buffer than this on some
// platform would only make the fixture margin bigger, never invalidate it).
const TYPICAL_PIPE_BUFFER_BYTES = 65536;

// Builds the real CLI binary once for every test in this file (each spawns
// dist/cli.js as a separate process): the CI workflow's test job runs `npx
// vitest run --coverage` without a preceding `npm run build`, so dist/cli.js
// cannot be assumed to exist (or be current) already.
beforeAll(() => {
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
});

function initGitRepo(repoPath: string): void {
  execSync("git init -q", { cwd: repoPath });
  execSync('git config user.email "t@example.com"', { cwd: repoPath });
  execSync('git config user.name "T"', { cwd: repoPath });
  execSync("git add .", { cwd: repoPath });
  execSync('git commit -qm "init"', { cwd: repoPath });
}

/**
 * Routes the shell-check's failure log into the throwaway repo copy instead
 * of the real ~/.agent-preflight/logs. These tests spawn the real CLI binary
 * as a separate process, so the in-process
 * tests/setup/no-real-home-writes.globalSetup.ts guard cannot see or
 * redirect it the way withFixture()'s explicit `logDir` does for in-process
 * runPreflight() calls elsewhere in this suite.
 */
function writePreflightConfig(repoPath: string): void {
  fs.writeFileSync(
    path.join(repoPath, ".preflight.json"),
    JSON.stringify({ logDir: path.join(repoPath, ".preflight-test-logs") })
  );
}

function setUpFixtureRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-${FIXTURE_NAME}-`));
  fs.cpSync(path.join(FIXTURES_ROOT, FIXTURE_NAME), repoPath, { recursive: true });
  writePreflightConfig(repoPath);
  initGitRepo(repoPath);
  return repoPath;
}

/**
 * A batch root containing exactly one repo copy of the overflow fixture.
 * One repo is already enough: its own envelope alone (~242 KB, see the
 * fixture's own file) is well past the 64 KB pipe buffer once wrapped in the
 * batch envelope, so a second repo would add nothing to the race this
 * exercises.
 */
function setUpBatchFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-batch-${FIXTURE_NAME}-`));
  const repoDir = path.join(root, "overflow-repo");
  fs.mkdirSync(repoDir);
  fs.cpSync(path.join(FIXTURES_ROOT, FIXTURE_NAME), repoDir, { recursive: true });
  writePreflightConfig(repoDir);
  initGitRepo(repoDir);
  return root;
}

/** Spawns the real CLI with a genuinely piped stdout and collects it whole. */
function runCliPiped(args: string[]): Promise<{ exitCode: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout: Buffer.concat(chunks) });
    });
  });
}

/**
 * Spawns the real CLI with a piped stdout AND a piped stderr, then destroys
 * the stdout read end immediately (before any data can arrive), forcing a
 * real EPIPE on the child's next stdout write the same way `preflight run
 * --json | head -c 100` does when the reader closes early.
 */
function runCliPipedThenCloseStdout(args: string[]): Promise<{ exitCode: number | null; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr: Buffer.concat(stderrChunks) });
    });
    // Destroying synchronously, right after spawn, before the child has had
    // a chance to write anything: the child's write to stdout then fails
    // with EPIPE rather than succeeding.
    child.stdout.destroy();
  });
}

describe("preflight run --json over a real piped stdout (task 0089e6f5)", () => {
  let repoPath: string;

  beforeAll(() => {
    repoPath = setUpFixtureRepo();
  });

  afterAll(() => {
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("yields a complete, parseable JSON document over a real pipe", async () => {
    const { exitCode, stdout } = await runCliPiped(["run", repoPath, "--json", "--no-audit", "--no-secrets"]);

    // Sanity check that this fixture is actually exercising the race: if
    // this ever drops below the buffer size (e.g. after an unrelated
    // envelope-shape change shrinks it), the test above stops being a
    // meaningful regression guard for the truncation bug.
    expect(stdout.length).toBeGreaterThan(TYPICAL_PIPE_BUFFER_BYTES);

    let parsed: { ready: boolean; checks: { name: string; status: string }[] };
    expect(() => {
      parsed = JSON.parse(stdout.toString("utf-8"));
    }).not.toThrow();

    expect(parsed!.ready).toBe(false);
    expect(parsed!.checks.find((c) => c.name === "npm-test")?.status).toBe("fail");
    // `preflight run --json`'s exit-code contract: 1 when not ready.
    expect(exitCode).toBe(1);
  }, 30_000);
});

describe("preflight batch --json over a real piped stdout (task 0089e6f5, round 2)", () => {
  let batchRoot: string;

  beforeAll(() => {
    batchRoot = setUpBatchFixtureRoot();
  });

  afterAll(() => {
    if (batchRoot) fs.rmSync(batchRoot, { recursive: true, force: true });
  });

  it("yields a complete, parseable JSON document over a real pipe", async () => {
    const { exitCode, stdout } = await runCliPiped(["batch", batchRoot, "--json", "--no-audit", "--no-secrets"]);

    // Same sanity check as the `run --json` case above: this batch envelope
    // must actually exceed the pipe buffer for the test to guard anything.
    expect(stdout.length).toBeGreaterThan(TYPICAL_PIPE_BUFFER_BYTES);

    let parsed: {
      total: number;
      notReady: number;
      results: Array<{ repo: string; result: { ready: boolean } | null }>;
    };
    expect(() => {
      parsed = JSON.parse(stdout.toString("utf-8"));
    }).not.toThrow();

    expect(parsed!.total).toBe(1);
    expect(parsed!.notReady).toBe(1);
    expect(parsed!.results[0]?.result?.ready).toBe(false);
    // `preflight batch --json`'s exit-code contract: 1 when any repo is not ready.
    expect(exitCode).toBe(1);
  }, 30_000);
});

describe("preflight run --json against a reader that closes the pipe immediately (real EPIPE, task 0089e6f5 round 2)", () => {
  let repoPath: string;

  beforeAll(() => {
    repoPath = setUpFixtureRepo();
  });

  afterAll(() => {
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("exits 1 with empty stderr instead of crashing or hanging on a broken pipe", async () => {
    const { exitCode, stderr } = await runCliPipedThenCloseStdout([
      "run",
      repoPath,
      "--json",
      "--no-audit",
      "--no-secrets",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr.length).toBe(0);
  }, 15_000);
});
