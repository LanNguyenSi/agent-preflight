import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import { runPreflight } from "../src/runner.js";
import {
  classifyBuildRequiredFailure,
  classifyBuildRequiredTestFailure,
  workflowTextShowsBuildBeforeTest,
} from "../src/checks/shared.js";

// Fixture repro for agent-tasks c5810885: `preflight run` in a fresh
// worktree of an npm-workspaces monorepo reported `ready: false`, blocker
// "npm test failed": the failing workspaces (debug-playbook-engine,
// domain-router) have a `cli-dist.test.ts` that intentionally fails loudly
// when `dist/` is missing, and the repo's own CI always runs `npm run
// build` before `npm test`. `tests/fixtures/monorepo-build-required`
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

  it("leaves dist/ unbuilt and the test check a named skip when --setup is not passed at all", async () => {
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

// Round-2 review HIGH-1: a monorepo can fail its `npm test` fan-out for
// MULTIPLE, INDEPENDENT reasons at once. Before this fixture existed, one
// build-required workspace's evidence anywhere in the combined output
// downgraded the WHOLE check to a non-blocking skip, hiding a genuinely
// broken, unrelated workspace in the same run -- `ready: true` with an
// empty `blockers` even though `broken`'s test is really failing.
describe("mixed monorepo: one build-required workspace + one genuinely broken workspace (fixture: monorepo-mixed-build-and-genuine-failure)", () => {
  it("stays a blocking fail; the genuine failure in one workspace is never hidden by another workspace's build-required evidence", async () => {
    const repoPath = copyFixtureToTmp("monorepo-mixed-build-and-genuine-failure");
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

// Round-2 review HIGH-2: `--setup`'s own build step can fail (the repo
// genuinely does not compile right now). Before this fixture existed, that
// failure was recorded ONLY as a `limitations` string and its output was
// discarded; the downstream test check then failed on the still-missing
// `dist/` and was downgraded to a non-blocking skip, reporting the repo
// READY with a remedy naming the very build step that had just failed.
describe("failing --setup build (fixture: monorepo-failing-build)", () => {
  it("is not reported ready, and the build's own error text is reachable, when the --setup build step itself fails", async () => {
    const repoPath = copyFixtureToTmp("monorepo-failing-build");
    try {
      const logDir = path.join(repoPath, ".preflight-test-logs");
      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      expect(result.ready).toBe(false);
      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(/--setup.*build step.*failed|--setup.*build step.*timed out/);

      // The build's own error text ("build error: intentional failure") is
      // reachable either directly in the message or via a persisted log
      // path the message names.
      const logPathMatch = testCheck?.message?.match(/\(see (.+)\)$/);
      if (logPathMatch) {
        const logContents = fs.readFileSync(logPathMatch[1], "utf-8");
        expect(logContents).toMatch(/build error: intentional failure/);
      } else {
        expect(testCheck?.message).toMatch(/build error: intentional failure/);
      }
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

// Round-2 review MEDIUM-3: a mutant that hardcodes `ciShowsBuildBeforeTest`
// to always return `true` survived the whole suite, because the only test
// exercising `--setup`'s build step used a fixture whose CI genuinely does
// show build-before-test (so the mutant made no observable difference
// there). This fixture's CI does NOT show build-before-test, so a mutant
// forcing the detection to `true` would incorrectly run the build and
// create `dist/` here -- killing it.
describe("--setup with no CI build-before-test signal (fixture: monorepo-build-required-no-ci-signal)", () => {
  it("does not build automatically under --setup when CI does not show build-before-test; the test check stays the same named skip", async () => {
    const repoPath = copyFixtureToTmp("monorepo-build-required-no-ci-signal");
    try {
      const logDir = path.join(repoPath, ".preflight-test-logs");
      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist"))).toBe(false);
      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("skip");
      expect(result.ready).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

// Round-2 review MEDIUM-2: the remedy string used to be unconditional --
// naming `npm run build` and `--setup` even for a repo with no `build`
// script anywhere, two dead ends.
describe("no build script found (fixture: single-package-no-build-script)", () => {
  it("names no build command in the remedy when the repo has no build script at all", async () => {
    const repoPath = copyFixtureToTmp("single-package-no-build-script");
    try {
      const logDir = path.join(repoPath, ".preflight-test-logs");
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).not.toMatch(/npm run build/);
      expect(testCheck?.message).toMatch(/not evaluated/);
      expect(result.ready).toBe(true);
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

  it("matches an ENOENT naming a dist/ path when a require/import stack accompanies it", () => {
    const output =
      "Error: ENOENT: no such file or directory, open '/repo/pkg/dist/index.js'\nRequire stack:\n- /repo/pkg/test.js";
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

  it("does not match 'Cannot find module' when the specifier has no dist/ segment at all", () => {
    const output = "Error: Cannot find module 'lodash'\nRequire stack:\n- /x/test.js";
    expect(classifyBuildRequiredFailure(output).matched).toBe(false);
  });

  it("returns matched:false for undefined output", () => {
    expect(classifyBuildRequiredFailure(undefined).matched).toBe(false);
  });

  // Round-2 review MEDIUM-1: the patterns above matched on cases a build
  // will never fix. Each of the following pins one of the five reviewer
  // inputs.
  describe("path credibility (MEDIUM-1)", () => {
    it("does not match a bare module specifier resolved via node_modules (no repo-relative or absolute shape)", () => {
      const output = "Error: Cannot find module 'some-lib/dist/index.js'\nRequire stack:\n- /x/test.js";
      expect(classifyBuildRequiredFailure(output).matched).toBe(false);
    });

    it("does not match an absolute path through node_modules (a dependency's own missing file, not this repo's)", () => {
      const output =
        "Error: Cannot find module '/repo/node_modules/some-lib/dist/index.js'\nRequire stack:\n- /repo/test.js";
      expect(classifyBuildRequiredFailure(output, "/repo").matched).toBe(false);
    });

    it("does not match a missing file inside a dist/ that already exists for that workspace (checked on the filesystem)", () => {
      const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-dist-built-"));
      try {
        const distDir = path.join(tmpRepo, "packages", "x", "dist");
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, "index.js"), "module.exports = {};\n");

        const missingFile = path.join(distDir, "helpr.js");
        const testFile = path.join(tmpRepo, "packages", "x", "test.js");
        const output = `Error: Cannot find module '${missingFile}'\nRequire stack:\n- ${testFile}`;
        expect(classifyBuildRequiredFailure(output, tmpRepo).matched).toBe(false);
      } finally {
        fs.rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it("does not match an ENOENT on a data file under dist/ that carries no require/import-stack context", () => {
      const output = "Error: ENOENT: no such file or directory, open '/repo/pkg/dist/cache/out.json'";
      expect(classifyBuildRequiredFailure(output).matched).toBe(false);
    });

    it("does not match a runner code frame echoing the error text as quoted source, not Node's own output", () => {
      const output =
        '125|     const output = "Error: Cannot find module \'./dist/index.js\'\\nRequire stack:";';
      expect(classifyBuildRequiredFailure(output).matched).toBe(false);
    });
  });
});

// Round-2 review HIGH-1: classifyBuildRequiredTestFailure is the
// per-workspace-aware entry point checks/test.ts actually calls.
describe("classifyBuildRequiredTestFailure (unit)", () => {
  it("falls back to whole-output classification when there is no per-workspace preamble (single-package repo)", () => {
    const output = "Error: Cannot find module './dist/index.js'\nRequire stack:\n- /x/test.js";
    expect(classifyBuildRequiredTestFailure(output).matched).toBe(true);
  });

  it("downgrades only when every failing workspace is build-required", () => {
    const output = [
      "> needs-build@1.0.0 test",
      "> node test.js",
      "",
      "Error: Cannot find module './dist/index.js'",
      "Require stack:",
      "- /repo/packages/needs-build/test.js",
      "npm error Lifecycle script `test` failed with error:",
      "npm error command failed",
    ].join("\n");
    const result = classifyBuildRequiredTestFailure(output);
    expect(result.matched).toBe(true);
    expect(result.workspaceNames).toEqual(["needs-build"]);
  });

  it("stays a blocker when one failing workspace has no build-required evidence, even if another does", () => {
    // Deliberately orders the build-required workspace FIRST and the
    // genuinely broken one SECOND: a mutant that disables the "every
    // failing workspace must match" guard and instead only looks at the
    // FIRST failing segment's own classification would still report
    // `matched: false` by coincidence if the broken workspace happened to
    // run first (its own classification is already `false`). Putting the
    // build-required (`matched: true`) segment first means only the real
    // guard -- not this ordering accident -- can produce `false` here (see
    // the fixture's own directory naming for the same reasoning against
    // the real npm fan-out: `packages/z-broken` sorts after
    // `packages/needs-build`).
    const output = [
      "> needs-build@1.0.0 test",
      "> node test.js",
      "",
      "Error: Cannot find module './dist/index.js'",
      "Require stack:",
      "- /repo/packages/needs-build/test.js",
      "npm error Lifecycle script `test` failed with error:",
      "npm error command failed",
      "",
      "> broken@1.0.0 test",
      "> node test.js",
      "",
      "AssertionError [ERR_ASSERTION]: deliberately wrong assertion",
      "2 !== 3",
      "    at Object.<anonymous> (/repo/packages/broken/test.js:6:8)",
      "npm error Lifecycle script `test` failed with error:",
      "npm error command failed",
    ].join("\n");
    expect(classifyBuildRequiredTestFailure(output).matched).toBe(false);
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

  // Round-2 review MEDIUM-4: the detection is by raw line order across the
  // WHOLE file, not by GitHub Actions' real job/`needs:` execution graph --
  // so a build step in a job that has nothing to do with the test job
  // still reads as "build before test" here. This is a documented, accepted
  // false HIT (costs only a redundant rebuild under --setup), pinned so a
  // future change to this detection does not silently start modeling jobs
  // without a corresponding doc update.
  it("still returns true for a build step in an unrelated job listed earlier in the file (documented false-hit cost: a redundant rebuild)", () => {
    const yaml = [
      "jobs:",
      "  unrelated-job:",
      "    steps:",
      "      - run: npm run build",
      "  test:",
      "    steps:",
      "      - run: npm test",
      "",
    ].join("\n");
    expect(workflowTextShowsBuildBeforeTest(yaml)).toBe(true);
  });

  it("does not treat a run: step that only echoes the words 'npm run build' as actually building", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: echo 'npm run build is documented'",
      "      - run: npm test",
      "",
    ].join("\n");
    expect(workflowTextShowsBuildBeforeTest(yaml)).toBe(false);
  });

  it("does not treat a run: step whose value is itself a shell comment as building", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: # npm run build",
      "      - run: npm test",
      "",
    ].join("\n");
    expect(workflowTextShowsBuildBeforeTest(yaml)).toBe(false);
  });
});
