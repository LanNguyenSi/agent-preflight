/**
 * Task 2e8bcc7e: `PREFLIGHT_LOG_DIR` lets a CLI run be pointed at an isolated
 * log directory without generating or editing a `.preflight.json` for the
 * target repo. Two known consumers this unblocks: a scratch-fixture run (a
 * copied fixture repo has no `.preflight.json` of its own) and a parallel
 * agent-preflight worktree sharing `$HOME` with other checkouts on the same
 * machine.
 *
 * This spawns the REAL built CLI binary (dist/cli.js, built fresh in this
 * file's own beforeAll, since the CI test job runs `npx vitest run
 * --coverage` with no preceding `npm run build`, same rationale as
 * tests/integration/json-stdout-pipe.test.ts) against a small fixture repo
 * whose `test` script deliberately fails, so `runShellCheck` persists a
 * full-output log. Both `HOME` and `PREFLIGHT_LOG_DIR` are overridden on the
 * child's env: `HOME` to a throwaway fake-home directory (so a regression
 * that ignores `PREFLIGHT_LOG_DIR` writes into a directory this test itself
 * controls and can inspect, never a machine's real `~/.agent-preflight/logs`,
 * see tests/setup/no-real-home-writes.globalSetup.ts, which guards
 * in-process runPreflight() calls only and cannot see a separate spawned
 * process), and `PREFLIGHT_LOG_DIR` to a second throwaway directory that the
 * assertions below expect the log to land in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

beforeAll(() => {
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
});

function initGitRepo(repoPath: string): void {
  execSync("git init -q", { cwd: repoPath });
  execSync('git config user.email "t@example.com"', { cwd: repoPath });
  execSync('git config user.name "T"', { cwd: repoPath });
  execSync("git add .", { cwd: repoPath });
  execSync('git commit -qm "feat: init"', { cwd: repoPath });
}

/** A minimal single-package repo whose `npm test` deliberately fails, with
 * no `.preflight.json` of its own (the case PREFLIGHT_LOG_DIR exists for:
 * a scratch fixture that carries no log-dir override of its own). */
function setUpFixtureRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-env-logdir-fixture-"));
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "fixture-env-logdir",
      version: "1.0.0",
      private: true,
      scripts: {
        test: "node -e \"console.error('deliberate fixture failure'); process.exitCode = 1;\"",
      },
    })
  );
  initGitRepo(repoPath);
  return repoPath;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["ignore", "ignore", "ignore"], env });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode }));
  });
}

/** Same as runCli, but captures stdout/stderr instead of discarding them,
 * for the case below that needs to assert on both streams: the
 * PREFLIGHT_LOG_DIR warning must land on stderr, never mixed into `--json`'s
 * stdout envelope. */
function runCliCapture(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function findLogFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".log"));
  } catch {
    return [];
  }
}

describe("preflight run honours PREFLIGHT_LOG_DIR (task 2e8bcc7e)", () => {
  let repoPath: string;
  let fakeHome: string;
  let envLogDir: string;

  beforeAll(() => {
    repoPath = setUpFixtureRepo();
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-env-logdir-fakehome-"));
    envLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-env-logdir-target-"));
  });

  afterAll(() => {
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
    if (envLogDir) fs.rmSync(envLogDir, { recursive: true, force: true });
  });

  it("writes the failing test's full-output log under PREFLIGHT_LOG_DIR, and none under the fake HOME's default", async () => {
    const { exitCode } = await runCli(["run", repoPath, "--no-audit", "--no-secrets"], {
      ...process.env,
      HOME: fakeHome,
      PREFLIGHT_LOG_DIR: envLogDir,
    });

    expect(exitCode).toBe(1);

    const logsUnderOverride = findLogFiles(envLogDir);
    expect(logsUnderOverride.length).toBeGreaterThan(0);
    expect(logsUnderOverride.some((name) => name.startsWith("npm-test-"))).toBe(true);

    const defaultLogsUnderFakeHome = path.join(fakeHome, ".agent-preflight", "logs");
    expect(fs.existsSync(defaultLogsUnderFakeHome)).toBe(false);
  }, 30_000);

  it("prints the PREFLIGHT_LOG_DIR warning on stderr, leaving --json's stdout parseable (missing test, task 2e8bcc7e)", async () => {
    // Own fake HOME, separate from the shared `fakeHome` above (review
    // finding F4, task 2e8bcc7e): this case's invalid PREFLIGHT_LOG_DIR
    // falls back to the home-based default and creates
    // `<home>/.agent-preflight/logs`, which would make the previous case's
    // "no default logs under fakeHome" assertion pass only because this
    // case runs after it, not because the code path is actually clean.
    const ownFakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-env-logdir-fakehome-invalid-"));
    try {
      const relativeEnvLogDir = "relative-not-absolute-logs";
      const { exitCode, stdout, stderr } = await runCliCapture(
        ["run", repoPath, "--no-audit", "--no-secrets", "--json"],
        {
          ...process.env,
          HOME: ownFakeHome,
          PREFLIGHT_LOG_DIR: relativeEnvLogDir,
        }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("PREFLIGHT_LOG_DIR");
      expect(stderr).toContain(relativeEnvLogDir);

      const parsed = JSON.parse(stdout);
      expect(parsed.ready).toBe(false);
    } finally {
      fs.rmSync(ownFakeHome, { recursive: true, force: true });
    }
  }, 30_000);
});
