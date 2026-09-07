/**
 * Task 0089e6f5: `preflight run --json` writes the full result envelope with
 * a single `console.log`/`process.stdout.write` call and used to call
 * `process.exit` immediately afterwards. Piping stdout is asynchronous: a
 * payload bigger than the OS pipe buffer (commonly 64 KB / 65536 bytes on
 * both Linux and macOS, confirmed by direct measurement against this
 * machine) only has its first chunk copied into the kernel synchronously,
 * and an immediate `process.exit` tears the process down before the
 * remainder is ever written: a reader on the other end of a real pipe sees
 * a cut-off, unparseable JSON document, even though the exact same payload
 * written to a regular file (no pipe-buffer limit) comes through complete.
 *
 * This spawns the REAL built CLI binary (dist/cli.js, built fresh in
 * beforeAll the same way tests/release-bundle.test.ts does, since the CI
 * workflow's test job does not run `npm run build` before `vitest run`)
 * with a genuinely piped stdout (child_process.spawn's `stdio: ["ignore",
 * "pipe", "ignore"]`, never a TTY) against a fixture whose own failing
 * test output is large enough to reliably exceed that buffer.
 *
 * The T-008 pathological-path-token fixture (single-package-pathological-
 * path-token, 30000 segments) was measured directly and does NOT reproduce
 * this: its full `--json` envelope is ~62-63 KB, under the 65536-byte pipe
 * buffer on this repo's dev/CI platforms, so it never actually exercises
 * the pipe-write race this fix addresses. This dedicated, larger fixture
 * (single-package-json-stdout-overflow) does; see its own file for why it
 * uses `process.exitCode` rather than `process.exit()` internally (the same
 * truncation race, one process down, would otherwise cap ITS OWN captured
 * output regardless of how large the token is made).
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

function setUpFixtureRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-${FIXTURE_NAME}-`));
  fs.cpSync(path.join(FIXTURES_ROOT, FIXTURE_NAME), repoPath, { recursive: true });
  // Routes the shell-check's failure log into the throwaway repo copy
  // instead of the real ~/.agent-preflight/logs (this spawns the real CLI
  // binary as a separate process, so the in-process
  // tests/setup/no-real-home-writes.globalSetup.ts guard cannot see or
  // redirect it the way withFixture()'s explicit `logDir` does for
  // in-process runPreflight() calls elsewhere in this suite).
  fs.writeFileSync(
    path.join(repoPath, ".preflight.json"),
    JSON.stringify({ logDir: path.join(repoPath, ".preflight-test-logs") })
  );
  execSync("git init -q", { cwd: repoPath });
  execSync('git config user.email "t@example.com"', { cwd: repoPath });
  execSync('git config user.name "T"', { cwd: repoPath });
  execSync("git add .", { cwd: repoPath });
  execSync('git commit -qm "init"', { cwd: repoPath });
  return repoPath;
}

/** Spawns the real CLI with a genuinely piped stdout and collects it whole. */
function runCliJsonPiped(repoPath: string): Promise<{ exitCode: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "run", repoPath, "--json", "--no-audit", "--no-secrets"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout: Buffer.concat(chunks) });
    });
  });
}

describe("preflight run --json over a real piped stdout (task 0089e6f5)", () => {
  let repoPath: string;

  beforeAll(() => {
    // Mirrors tests/release-bundle.test.ts: the CI workflow's test job runs
    // `npx vitest run --coverage` without a preceding `npm run build`, so
    // dist/cli.js cannot be assumed to exist (or be current) already.
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
    repoPath = setUpFixtureRepo();
  });

  afterAll(() => {
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("yields a complete, parseable JSON document over a real pipe", async () => {
    const { exitCode, stdout } = await runCliJsonPiped(repoPath);

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
