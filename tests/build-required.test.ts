import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import { runPreflight } from "../src/runner.js";
import { classifyBuildRequiredFailure, workflowTextShowsBuildBeforeTest } from "../src/checks/shared.js";

// Fixture repro for agent-tasks c5810885: `preflight run` in a fresh
// worktree of an npm-workspaces monorepo reported `ready: false` with
// blocker "npm test failed" because a workspace's test intentionally fails
// loudly when its own `dist/` has not been built yet, even though the
// repo's own CI always builds first. `tests/fixtures/monorepo-build-required`
// reproduces that shape with zero external dependencies (plain `node`
// scripts, no bundler) so the fixture runs fast and offline; the actual
// production case (a real workspace's `cli-dist.test.ts` requiring its own
// package's build output) fails the exact same way -- Node's own
// `Cannot find module '<path-through-dist/>'`.
const FIXTURES_ROOT = path.join(__dirname, "fixtures");

function copyFixtureToTmp(fixtureName: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-${fixtureName}-`));
  fs.cpSync(path.join(FIXTURES_ROOT, fixtureName), tmpRoot, { recursive: true });
  execSync("git init -q", { cwd: tmpRoot });
  execSync('git config user.email "t@example.com"', { cwd: tmpRoot });
  execSync('git config user.name "T"', { cwd: tmpRoot });
  execSync("git add .", { cwd: tmpRoot });
  execSync('git commit -qm "init"', { cwd: tmpRoot });
  return tmpRoot;
}

// Scoped to the test check only: git-state, lint, typecheck, audit,
// secret-detection, commit-convention, ci-simulation, and tdd are all
// irrelevant to this feature and would only add noise (or, for git-state,
// a spurious "uncommitted changes" blocker once a test writes a build
// artifact into the copied fixture).
const TEST_ONLY_CHECKS = {
  gitState: false,
  lint: false,
  typecheck: false,
  test: true,
  audit: false,
  secretDetection: false,
  commitConvention: false,
  ciSimulation: false,
  tdd: false,
} as const;

describe("build-required test classification (fixture: monorepo-build-required)", () => {
  let repoPath: string;
  let logDir: string;

  beforeEach(() => {
    repoPath = copyFixtureToTmp("monorepo-build-required");
    logDir = path.join(repoPath, ".preflight-test-logs");
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("classifies the not-built state as a named skip with the remedy, not a blocker", async () => {
    const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

    const testCheck = result.checks.find((c) => c.kind === "test");
    expect(testCheck?.status).toBe("skip");
    expect(testCheck?.message).toMatch(/build required before test/);
    expect(testCheck?.message).toMatch(/npm run build/);
    expect(testCheck?.message).toMatch(/--setup/);

    expect(result.blockers).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.limitations.some((l) => l.includes("build required before test"))).toBe(true);
  });

  it("passes once the workspace has been built manually", async () => {
    execSync("npm run build --workspaces --if-present", { cwd: repoPath });

    const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
    const testCheck = result.checks.find((c) => c.kind === "test");
    expect(testCheck?.status).toBe("pass");
    expect(result.ready).toBe(true);
  });

  it("builds automatically under --setup when a build script exists and CI shows build-before-test", async () => {
    expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist"))).toBe(false);

    const result = await runPreflight(repoPath, {
      checks: TEST_ONLY_CHECKS,
      logDir,
      setup: { enabled: true },
    });

    const testCheck = result.checks.find((c) => c.kind === "test");
    expect(testCheck?.status).toBe("pass");
    expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist", "index.js"))).toBe(true);
  });

  it("does not build automatically without --setup (today's --setup behavior for a non-enabled run)", async () => {
    const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
    expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist"))).toBe(false);
    expect(result.checks.find((c) => c.kind === "test")?.status).toBe("skip");
  });
});

describe("negative control (fixture: monorepo-genuine-test-failure)", () => {
  it("keeps a genuine test failure a blocker; the classifier never reclassifies it", async () => {
    const repoPath = copyFixtureToTmp("monorepo-genuine-test-failure");
    try {
      const logDir = path.join(repoPath, ".preflight-test-logs");
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("fail");
      expect(result.ready).toBe(false);
      expect(result.blockers).toContain("npm test failed");
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("classifyBuildRequiredFailure (unit)", () => {
  it("matches Node's 'Cannot find module' error naming a dist/ path", () => {
    const output = "Error: Cannot find module './dist/index.js'\nRequire stack:\n- /x/test.js";
    const result = classifyBuildRequiredFailure(output);
    expect(result.matched).toBe(true);
    expect(result.cause).toMatch(/dist\/index\.js/);
  });

  it("matches an ENOENT naming a dist/ path", () => {
    const output = "Error: ENOENT: no such file or directory, open '/repo/pkg/dist/index.js'";
    expect(classifyBuildRequiredFailure(output).matched).toBe(true);
  });

  it("matches an explicit workspace precondition message (dist/ + missing + npm run build, same line)", () => {
    const output = "Error: dist/index.js is missing; run `npm run build` first";
    expect(classifyBuildRequiredFailure(output).matched).toBe(true);
  });

  it("does not match a generic assertion failure with no dist/ evidence", () => {
    const output = "AssertionError [ERR_ASSERTION]: 2 !== 3\n  at Object.<anonymous> (/x/test.js:6:8)";
    expect(classifyBuildRequiredFailure(output).matched).toBe(false);
  });

  it("does not match a failure that only mentions 'dist' without missing-artifact evidence", () => {
    const output = "AssertionError: expected 'dist/v2' to equal 'dist/v3'";
    expect(classifyBuildRequiredFailure(output).matched).toBe(false);
  });

  it("does not match 'missing' and 'dist' mentioned separately without an npm run build remedy", () => {
    const output = "Error: something is missing here\nand dist/ was mentioned on another line too";
    expect(classifyBuildRequiredFailure(output).matched).toBe(false);
  });

  it("returns matched:false for undefined output", () => {
    expect(classifyBuildRequiredFailure(undefined).matched).toBe(false);
  });
});

describe("workflowTextShowsBuildBeforeTest (unit)", () => {
  it("detects a build step before a test step in a single job", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm ci",
      "      - run: npm run build",
      "      - run: npm test",
      "",
    ].join("\n");
    expect(workflowTextShowsBuildBeforeTest(yaml)).toBe(true);
  });

  it("returns false when test runs before build", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm test",
      "      - run: npm run build",
      "",
    ].join("\n");
    expect(workflowTextShowsBuildBeforeTest(yaml)).toBe(false);
  });

  it("returns false when there is no build step at all", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm ci",
      "      - run: npm test",
      "",
    ].join("\n");
    expect(workflowTextShowsBuildBeforeTest(yaml)).toBe(false);
  });

  it("returns false for this repo's own CI workflow (no build step; vitest runs TS source directly)", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf-8");
    expect(workflowTextShowsBuildBeforeTest(text)).toBe(false);
  });
});
