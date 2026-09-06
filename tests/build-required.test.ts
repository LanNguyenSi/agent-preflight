import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import { runPreflight } from "../src/runner.js";
import {
  evaluateBuildPrecondition,
  evaluateBuildRequiredTestFailure,
  findMissingArtifactEvidence,
  splitWorkspaceSegments,
  workflowTextShowsBuildBeforeTest,
} from "../src/checks/shared.js";

// Fixture repro for agent-tasks c5810885: `preflight run` in a fresh worktree
// of an npm-workspaces monorepo reported `ready: false`, blocker "npm test
// failed": the failing workspaces have a `cli-dist.test.ts` that fails loudly
// when `dist/` is missing, and the repo's own CI always runs `npm run build`
// before `npm test`. The fixtures reproduce that shape with zero external
// dependencies (plain `node` scripts, no bundler) so they run fast and
// offline; the real case fails the same way.
//
// The decision under test is the FILESYSTEM precondition, not the wording of
// the failure: a failing check is only downgraded to the named skip when the
// failing package has a build script and a declared artifact missing on disk,
// AND its own output blames that missing artifact. Each fixture below pins one
// side of that, in both states where a build can change the answer.
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

// Runs `body` against a throwaway copy of a fixture and always removes it.
async function withFixture<T>(fixtureName: string, body: (repoPath: string, logDir: string) => Promise<T>): Promise<T> {
  const repoPath = copyFixtureToTmp(fixtureName);
  try {
    return await body(repoPath, path.join(repoPath, ".preflight-test-logs"));
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

// Scoped to the test check only: git-state, lint, typecheck, audit,
// secret-detection, commit-convention, ci-simulation, and tdd are all
// irrelevant to this feature and would only add noise (or, for git-state, a
// spurious "uncommitted changes" blocker once a build writes into the copy).
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

function testCheckOf(result: { checks: { kind: string; status: string; message?: string }[] }) {
  return result.checks.find((check) => check.kind === "test");
}

describe("unbuilt workspace, build required (fixture: monorepo-build-required)", () => {
  it("is a named skip with the remedy, not a blocker, while dist/ is missing", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/build required before test/);
      expect(testCheck?.message).toMatch(/packages\/needs-build\/dist has not been built/);
      expect(testCheck?.message).toMatch(/npm run build/);
      expect(testCheck?.message).toMatch(/--setup/);

      expect(result.blockers).toEqual([]);
      expect(result.ready).toBe(true);
      expect(result.limitations.some((l) => l.includes("build required before test"))).toBe(true);
    });
  });

  it("passes once the workspace has been built manually", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      execSync("npm run build --workspaces --if-present", { cwd: repoPath });

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(result)?.status).toBe("pass");
      expect(result.ready).toBe(true);
    });
  });

  it("builds automatically under --setup when a build script exists and CI shows build-before-test", async () => {
    await withFixture("monorepo-build-required", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist"))).toBe(false);

      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      expect(testCheckOf(result)?.status).toBe("pass");
      expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist", "index.js"))).toBe(true);
    });
  });
});

// Case (i): a single-package repo whose suite reports BOTH a missing build
// artifact and an ordinary assertion failure in the same run. Unbuilt, the
// run is "not evaluated": the suite never ran against the code it is meant to
// test, so its verdict -- including the assertion -- says nothing yet. Built,
// the same repo's surviving assertion failure is a genuine blocker. This is
// the pair the whole feature turns on, so both states are asserted here.
describe("single package, mixed output (fixture: single-package-build-required-mixed)", () => {
  it("is a named skip while the package is unbuilt, even though the same run also fails an assertion", async () => {
    await withFixture("single-package-build-required-mixed", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/dist\/index\.js has not been built/);
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
    });
  });

  it("is a blocking fail once the package is built and the assertion still fails", async () => {
    await withFixture("single-package-build-required-mixed", async (repoPath, logDir) => {
      execSync("npm run build", { cwd: repoPath });

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(result)?.status).toBe("fail");
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// Cases (ii)/(viii): the package IS built -- every artifact it declares is on
// disk -- and its suite reports a relative `./dist/...` module error for some
// other file inside that dist/, next to an assertion failure. A missing file
// inside an already-built dist/ is a different bug; a build would not fix it.
describe("built workspace, artifacts present (fixture: monorepo-built-artifacts-present)", () => {
  it("stays a blocking fail and says the declared artifacts are present", async () => {
    await withFixture("monorepo-built-artifacts-present", async (repoPath, logDir) => {
      execSync("npm run build --workspaces --if-present", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "packages", "built-pkg", "dist", "index.js"))).toBe(true);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(/declared build artifacts are all present on disk/);
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// Case (iii), both orders: a monorepo can fail its `npm test` fan-out for
// MULTIPLE, INDEPENDENT reasons at once. The genuinely broken workspace must
// keep the whole check blocking whether npm prints it before or after the
// unbuilt one, so neither ordering can be mistaken for the rule.
describe("mixed monorepo: one unbuilt workspace + one genuinely broken workspace", () => {
  it("stays a blocking fail when the broken workspace runs second (fixture: monorepo-mixed-build-and-genuine-failure)", async () => {
    await withFixture("monorepo-mixed-build-and-genuine-failure", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      expect(testCheckOf(result)?.status).toBe("fail");
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });

  it("stays a blocking fail when the broken workspace runs first (fixture: monorepo-mixed-genuine-first)", async () => {
    await withFixture("monorepo-mixed-genuine-first", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      expect(testCheckOf(result)?.status).toBe("fail");
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// Case (iv): no build script anywhere. Nothing can produce the artifact the
// output names, so "run the build first" is not a remedy and the failure is
// not a build-required skip.
describe("no build script anywhere (fixture: single-package-no-build-script)", () => {
  it("stays a blocking fail and names the missing-module observation", async () => {
    await withFixture("single-package-no-build-script", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(/no `build` script was found/);
      expect(testCheck?.message).toMatch(/dist\/index\.js/);
      expect(result.ready).toBe(false);
    });
  });
});

// The plain negative control: a genuine bug, no build precondition anywhere
// near it. Its message must stay the unadorned blocker.
describe("negative control (fixture: monorepo-genuine-test-failure)", () => {
  it("keeps a genuine test failure a blocker with no build-required wording", async () => {
    await withFixture("monorepo-genuine-test-failure", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toBe("npm test failed");
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// The precondition alone is not enough: this package is unbuilt AND has a
// build script, but its failure has nothing to do with the missing artifact
// and does not name it. Downgrading it would report a genuinely broken suite
// as `ready: true` -- the shape any package that compiles to dist/ but tests
// from source has (this repo included).
describe("unbuilt package, unrelated failure (fixture: single-package-unbuilt-unrelated-failure)", () => {
  it("stays a blocking fail because the failure does not name the missing artifact", async () => {
    await withFixture("single-package-unbuilt-unrelated-failure", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(/does not name it/);
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// Case (v): `--setup`'s own build step exits non-zero. The repo genuinely does
// not build right now, so the subsequent missing-artifact failure is a real
// break, and the build's own error text must stay reachable.
describe("failing --setup build (fixture: monorepo-failing-build)", () => {
  it("is a blocking fail naming the exit code, with the build output persisted", async () => {
    await withFixture("monorepo-failing-build", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      expect(result.ready).toBe(false);
      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(/--setup.*build step.*failed \(exit code 2\)/);

      const logPathMatch = testCheck?.message?.match(/\(see (.+)\)$/);
      if (logPathMatch) {
        expect(fs.readFileSync(logPathMatch[1], "utf-8")).toMatch(/build error: intentional failure/);
      } else {
        expect(testCheck?.message).toMatch(/build error: intentional failure/);
      }
    });
  });
});

// Case (vi): `--setup`'s build step exhausts its own timeout. Nothing was
// learned about the repo, so the test check stays "not evaluated" (with the
// timeout named) instead of becoming a blocker -- the same direction every
// other did-not-answer path in this project takes. `setup.buildTimeoutMs`
// keeps this test fast; the default is 300000.
describe("--setup build timeout (fixture: monorepo-slow-build)", () => {
  it("is a named skip naming the timeout, not a blocker", async () => {
    await withFixture("monorepo-slow-build", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true, buildTimeoutMs: 200 },
      });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/timed out/);
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
      expect(result.limitations.some((l) => /npm run build timed out after 200 ms/.test(l))).toBe(true);
    });
  });
});

// A build that exits 0 without producing anything: the artifacts are still
// missing and the tests still fail, but the build already ran, so "run the
// build first" would be a dead end and the failure is real.
describe("--setup build succeeds without producing artifacts (fixture: monorepo-noop-build)", () => {
  it("stays a blocking fail after a successful build", async () => {
    await withFixture("monorepo-noop-build", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(/completed successfully/);
      expect(result.ready).toBe(false);
    });
  });
});

// Case (vii): a build script exists, but this repo's CI does not show
// build-before-test, so `--setup` must not run a build it was never asked
// for. The test check falls back to the same named skip.
describe("--setup with no CI build-before-test signal (fixture: monorepo-build-required-no-ci-signal)", () => {
  it("does not build, and the test check stays the named skip", async () => {
    await withFixture("monorepo-build-required-no-ci-signal", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, {
        checks: TEST_ONLY_CHECKS,
        logDir,
        setup: { enabled: true },
      });

      expect(fs.existsSync(path.join(repoPath, "packages", "needs-build", "dist"))).toBe(false);
      expect(testCheckOf(result)?.status).toBe("skip");
      expect(result.ready).toBe(true);
    });
  });
});

function withTempPackage<T>(files: Record<string, string>, body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-precondition-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pkg = (value: Record<string, unknown>): string => JSON.stringify(value);

describe("evaluateBuildPrecondition (unit)", () => {
  it("is met when a build script exists and a declared entry point is missing", () => {
    withTempPackage(
      { "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }) },
      (dir) => {
        const result = evaluateBuildPrecondition(dir, dir);
        expect(result.met).toBe(true);
        expect(result.missingArtifact).toBe("dist/index.js");
      }
    );
  });

  it("is not met when every declared entry point is present", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }),
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => expect(evaluateBuildPrecondition(dir, dir).met).toBe(false)
    );
  });

  it("is not met without a build script, however missing the artifacts are", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js" }) }, (dir) => {
      const result = evaluateBuildPrecondition(dir, dir);
      expect(result.met).toBe(false);
      expect(result.hasBuildScript).toBe(false);
    });
  });

  it("falls back to dist/ for a package that declares no entry points at all", () => {
    withTempPackage({ "package.json": pkg({ name: "x", scripts: { build: "node build.js" } }) }, (dir) => {
      const result = evaluateBuildPrecondition(dir, dir);
      expect(result.met).toBe(true);
      expect(result.missingArtifact).toBe("dist");
    });
  });

  it("is not met when the fallback dist/ already exists", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", scripts: { build: "node build.js" } }),
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => expect(evaluateBuildPrecondition(dir, dir).met).toBe(false)
    );
  });

  it("reads the tsconfig outDir as a declared artifact", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", scripts: { build: "tsc" } }),
        "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "build" } }),
      },
      (dir) => {
        const result = evaluateBuildPrecondition(dir, dir);
        expect(result.met).toBe(true);
        expect(result.missingArtifact).toBe("build");
      }
    );
  });

  it("resolves an extensionless entry point the way Node does, so a built package is not read as unbuilt", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "./dist/index", scripts: { build: "tsc" } }),
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => expect(evaluateBuildPrecondition(dir, dir).met).toBe(false)
    );
  });

  it("reads exports string leaves, and ignores a wildcard subpath it cannot check", () => {
    withTempPackage(
      {
        "package.json": pkg({
          name: "x",
          scripts: { build: "tsc" },
          exports: { ".": { import: "./dist/index.mjs" }, "./sub/*": "./dist/sub/*.js" },
        }),
      },
      (dir) => {
        const result = evaluateBuildPrecondition(dir, dir);
        expect(result.met).toBe(true);
        expect(result.missingArtifact).toBe("./dist/index.mjs");
      }
    );
  });

  it("reads bin map values", () => {
    withTempPackage(
      { "package.json": pkg({ name: "x", scripts: { build: "tsc" }, bin: { cli: "dist/cli.js" } }) },
      (dir) => expect(evaluateBuildPrecondition(dir, dir).missingArtifact).toBe("dist/cli.js")
    );
  });

  it("accepts a root build script that fans out over the workspaces for a workspace with none of its own", () => {
    withTempPackage(
      {
        "package.json": pkg({
          name: "root",
          workspaces: ["packages/*"],
          scripts: { build: "npm run build --workspaces --if-present" },
        }),
        "packages/w/package.json": pkg({ name: "w", main: "dist/index.js" }),
      },
      (dir) => {
        const result = evaluateBuildPrecondition(path.join(dir, "packages", "w"), dir);
        expect(result.hasBuildScript).toBe(true);
        expect(result.met).toBe(true);
      }
    );
  });

  it("does not accept a root build script of any other shape for a workspace with none of its own", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "root", workspaces: ["packages/*"], scripts: { build: "tsc -b" } }),
        "packages/w/package.json": pkg({ name: "w", main: "dist/index.js" }),
      },
      (dir) => {
        const result = evaluateBuildPrecondition(path.join(dir, "packages", "w"), dir);
        expect(result.hasBuildScript).toBe(false);
        expect(result.met).toBe(false);
      }
    );
  });
});

describe("splitWorkspaceSegments (unit)", () => {
  const workspaceRun = [
    "> repo@1.2.3 test",
    "> npm run test --workspaces --if-present",
    "",
    "> needs-build@1.0.0 test",
    "> node test.js",
    "Error: Cannot find module './dist/index.js'",
    "npm error Lifecycle script `test` failed with error:",
  ].join("\n");

  it("excludes the root package's own preamble even when the root carries a version", () => {
    const segments = splitWorkspaceSegments(workspaceRun, { name: "repo", version: "1.2.3" });
    expect(segments).toHaveLength(1);
    expect(segments?.[0].split("\n")[0]).toBe("> needs-build@1.0.0 test");
  });

  it("treats the versioned root preamble as a workspace when the root identity is unknown", () => {
    // Pins the reason the identity is passed at all: without it, npm 11's
    // `> repo@1.2.3 test` line is indistinguishable from a workspace's.
    expect(splitWorkspaceSegments(workspaceRun)).toHaveLength(2);
  });

  it("captures a scoped workspace name", () => {
    const output = [
      "> @scope/pkg@0.1.2 test",
      "> jest",
      "npm error Lifecycle script `test` failed with error:",
    ].join("\n");
    const segments = splitWorkspaceSegments(output, { name: "root", version: "1.0.0" });
    expect(segments).toHaveLength(1);
    expect(segments?.[0]).toContain("@scope/pkg@0.1.2");
  });

  it("returns undefined when there is no workspace preamble at all", () => {
    expect(splitWorkspaceSegments("> test\n> node test.js\nAssertionError: nope")).toBeUndefined();
  });
});

describe("findMissingArtifactEvidence (unit)", () => {
  const repoPath = path.resolve("/repo");

  it("matches a package's own guard message naming the declared artifact, with no Error: prefix", () => {
    // The real shape from the reported friction: a test that throws its own
    // message, printed by the runner without any Node error prefix.
    const output =
      "  /repo/packages/x/dist/index.js is missing. Run `npm run build` in packages/x before testing.";
    expect(findMissingArtifactEvidence(output, { repoPath, missingArtifact: "dist/index.js" })).toMatch(
      /dist\/index\.js is missing/
    );
  });

  it("matches a relative module-resolution failure", () => {
    const output = "Error: Cannot find module './dist/index.js'";
    expect(findMissingArtifactEvidence(output, { repoPath })).toContain("Cannot find module");
  });

  it("does not match a bare module specifier (an ordinary missing dependency)", () => {
    expect(findMissingArtifactEvidence("Error: Cannot find module 'lodash'", { repoPath })).toBeUndefined();
  });

  it("does not match a path resolved through node_modules", () => {
    const output = "Error: Cannot find module '/repo/node_modules/some-lib/dist/index.js'";
    expect(findMissingArtifactEvidence(output, { repoPath })).toBeUndefined();
  });

  it("does not match an absolute path outside the repo", () => {
    const output = "Error: Cannot find module '/elsewhere/dist/index.js'";
    expect(findMissingArtifactEvidence(output, { repoPath })).toBeUndefined();
  });

  it("does not match an assertion failure that names neither a module nor the artifact", () => {
    const output = "AssertionError [ERR_ASSERTION]: 2 !== 3\n  at Object.<anonymous> (/repo/test.js:6:8)";
    expect(findMissingArtifactEvidence(output, { repoPath, missingArtifact: "dist/index.js" })).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(findMissingArtifactEvidence(undefined, { repoPath })).toBeUndefined();
  });
});

describe("evaluateBuildRequiredTestFailure and the --setup build outcome (unit)", () => {
  const output = "Error: Cannot find module './dist/index.js'";

  it("never downgrades after a --setup build that exited non-zero", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }) }, (dir) => {
      const result = evaluateBuildRequiredTestFailure({
        repoPath: dir,
        output,
        setupBuildOutcome: { attempted: true, succeeded: false, timedOut: false, exitCode: 2, logPath: "/logs/b.log" },
      });
      expect(result.downgrade).toBe(false);
      expect(result.note).toMatch(/failed \(exit code 2\).*\/logs\/b\.log/);
    });
  });

  it("never downgrades after a --setup build that succeeded", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }) }, (dir) => {
      const result = evaluateBuildRequiredTestFailure({
        repoPath: dir,
        output,
        setupBuildOutcome: { attempted: true, succeeded: true, timedOut: false, exitCode: 0 },
      });
      expect(result.downgrade).toBe(false);
      expect(result.note).toMatch(/completed successfully/);
    });
  });

  it("still downgrades after a --setup build that timed out, and names the timeout", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }) }, (dir) => {
      const result = evaluateBuildRequiredTestFailure({
        repoPath: dir,
        output,
        setupBuildOutcome: { attempted: true, succeeded: false, timedOut: true },
      });
      expect(result.downgrade).toBe(true);
      expect(result.note).toMatch(/timed out/);
    });
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

  // The detection is by raw line order across the WHOLE file, not by GitHub
  // Actions' real job/`needs:` execution graph, so a build step in a job that
  // has nothing to do with the test job still reads as "build before test".
  // A documented, accepted false HIT (it costs only a redundant rebuild under
  // --setup), pinned so a future change does not silently start modeling jobs
  // without a corresponding doc update.
  it("still returns true for a build step in an unrelated job listed earlier in the file", () => {
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
