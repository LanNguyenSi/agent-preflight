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
  rootBuildScriptFansOutToWorkspaces,
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
  // `verbatimSymlinks` keeps a fixture's own symlink as it was written
  // (`dist -> lib`). Without it, `cp` resolves the link against the SOURCE
  // directory and the copy ends up pointing back into `tests/fixtures/`,
  // which would make the symlink fixture test the checked-in tree instead of
  // its own copy.
  fs.cpSync(path.join(FIXTURES_ROOT, fixtureName), tmpRoot, { recursive: true, verbatimSymlinks: true });
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
      expect(testCheck?.message).toMatch(/a declared build artifact \(packages\/needs-build\/dist\) is missing/);
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
      expect(testCheck?.message).toMatch(/a declared build artifact \(dist\/index\.js\) is missing/);
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

// A PARTIALLY built package: its build legitimately never emits one of the
// artifacts it declares, so the filesystem precondition is met permanently
// while the real dist/ sits on disk and is exactly what the tests load. A
// genuine runtime failure inside that live dist/ then prints a Node stack
// frame pointing into it. Only the "the corroborating path must itself be
// absent" half of the anchor rule separates that from a missing build -- and
// the giveaway that it is not a missing build is that the verdict must not
// change after a successful `npm run build`, which cannot create the
// artifact either.
describe("partially built package, declared `types` never emitted (fixture: single-package-partial-build-types)", () => {
  it("stays a blocking fail although the precondition holds, and stays one after a successful build", async () => {
    await withFixture("single-package-partial-build-types", async (repoPath, logDir) => {
      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "index.d.ts"))).toBe(false);

      const first = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(first)?.status).toBe("fail");
      expect(testCheckOf(first)?.message).not.toMatch(/build required before test/);
      expect(first.ready).toBe(false);
      expect(first.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);

      // Sticky check: running the build again changes nothing on disk that
      // could turn this into a real "not built yet", so the verdict must be
      // identical rather than flipping to a skip.
      execSync("npm run build", { cwd: repoPath });
      const second = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(second)?.status).toBe("fail");
      expect(second.ready).toBe(false);
    });
  });
});

describe("partially built package, `exports` subpath never emitted (fixture: single-package-partial-build-exports)", () => {
  it("stays a blocking fail: the failing path is present in the same dist/", async () => {
    await withFixture("single-package-partial-build-exports", async (repoPath, logDir) => {
      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "extra.js"))).toBe(false);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// The two sides of the comparison come from different places: the declared
// artifact is spelled against the package directory, while the path a runner
// prints comes out of a process that already resolved it. A package whose
// `dist` is a symlink to its real output directory is the case where the two
// spellings differ for a plainly unbuilt package.
describe("unbuilt package whose dist/ is a symlink (fixture: single-package-symlinked-dist)", () => {
  it("is the named skip: the declared artifact and the reported path canonicalize to the same file", async () => {
    await withFixture("single-package-symlinked-dist", async (repoPath, logDir) => {
      expect(fs.lstatSync(path.join(repoPath, "dist")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "lib"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(false);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/build required before test/);
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
    });
  });

  it("passes once the package has been built", async () => {
    await withFixture("single-package-symlinked-dist", async (repoPath, logDir) => {
      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      expect(testCheckOf(result)?.status).toBe("pass");
      expect(result.ready).toBe(true);
    });
  });
});

// Untrusted input: the failing test's own output decides how much path
// walking this classification does. An unbounded implementation aborted the
// whole run here (RangeError, raw stack trace, no JSON at all), which turned
// a reportable test failure into no report.
describe("pathological path token in test output (fixture: single-package-pathological-path-token)", () => {
  it("still produces a verdict, with the test failure as a blocker", async () => {
    await withFixture("single-package-pathological-path-token", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
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

// ---------------------------------------------------------------------------
// Adversarial fixtures: everything that has to STAY a blocker although the
// filesystem precondition holds, plus the one shape that legitimately skips.
// Each of these reproduces a way a text-matching corroboration was defeated:
// the failing package is unbuilt and its output names a path, and the only
// thing separating "not built yet" from a genuine bug is WHERE that path
// resolves to.
// ---------------------------------------------------------------------------

// Asserts the shape every blocking case here shares: a real blocker, and a
// message that never claims the run was not evaluated for a missing build.
function expectBlockingFailure(result: { ready: boolean; blockers: string[]; checks: { kind: string; status: string; message?: string }[] }) {
  const testCheck = testCheckOf(result);
  expect(testCheck?.status).toBe("fail");
  expect(result.ready).toBe(false);
  expect(result.blockers.some((blocker) => blocker.startsWith("npm test failed"))).toBe(true);
  expect(testCheck?.message).not.toMatch(/build required before test/);
  expect(testCheck?.message).not.toMatch(/not evaluated/);
  return testCheck;
}

describe("unbuilt package, stale relative require (fixture: single-package-stale-relative-require)", () => {
  it("stays a blocking fail: the missing path is in the package's source tree, not its build output", async () => {
    await withFixture("single-package-stale-relative-require", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = expectBlockingFailure(result);
      expect(testCheck?.message).toMatch(/does not name it/);
    });
  });
});

describe("mixed monorepo, both workspaces unbuilt (fixture: monorepo-stale-relative-require)", () => {
  it("stays a blocking fail and names the broken workspace, although its precondition holds too", async () => {
    await withFixture("monorepo-stale-relative-require", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = expectBlockingFailure(result);
      expect(testCheck?.message).toMatch(/workspace `broken`/);
      expect(testCheck?.message).toMatch(/does not name it/);
    });
  });
});

describe("unbuilt package, missing dependency (fixture: single-package-missing-dependency)", () => {
  it("stays a blocking fail: a node_modules path names a dependency, not this repo's build output", async () => {
    await withFixture("single-package-missing-dependency", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      expectBlockingFailure(result);
    });
  });
});

describe("unbuilt package with no declarations, runner frame (fixture: single-package-fallback-runner-frame)", () => {
  it("stays a blocking fail: a node_modules stack frame is not evidence about the fallback dist/", async () => {
    await withFixture("single-package-fallback-runner-frame", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      expectBlockingFailure(result);
    });
  });
});

describe("unbuilt workspace naming a neighbour's artifact (fixture: monorepo-cross-workspace-artifact)", () => {
  it("stays a blocking fail: another package's artifact says nothing about this one", async () => {
    await withFixture("monorepo-cross-workspace-artifact", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = expectBlockingFailure(result);
      expect(testCheck?.message).toMatch(/workspace `a`/);
    });
  });
});

// The motivating shape from the report: a workspace test whose first assertion
// is that the package was built, throwing its own message with the ABSOLUTE
// artifact path. Both states, because this is the pair the feature exists for.
describe("unbuilt workspace, absolute guard path (fixture: monorepo-absolute-guard-path)", () => {
  it("is the named skip while the workspace is unbuilt", async () => {
    await withFixture("monorepo-absolute-guard-path", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/build required before test/);
      expect(testCheck?.message).toMatch(/a declared build artifact \(packages\/needs-build\/dist\/index\.js\) is missing/);
      expect(testCheck?.message).toMatch(/the test output reports: Error: \//);
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
    });
  });

  it("passes once the workspace has been built", async () => {
    await withFixture("monorepo-absolute-guard-path", async (repoPath, logDir) => {
      execSync("npm run build --workspaces --if-present", { cwd: repoPath });

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(result)?.status).toBe("pass");
      expect(result.ready).toBe(true);
    });
  });
});

describe("workspace without a build script of its own (fixture: monorepo-workspace-without-build-script)", () => {
  it("stays a blocking fail: an --if-present root fan-out skips it, so no build covers it", async () => {
    await withFixture("monorepo-workspace-without-build-script", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = expectBlockingFailure(result);
      expect(testCheck?.message).toMatch(/no `build` script was found for workspace `w`/);
      // The quoted observation is this package's own missing module, not the
      // dependency under its node_modules and not the nested package's path.
      expect(testCheck?.message).toMatch(/\.\/dist\/index\.js/);
      expect(testCheck?.message).not.toMatch(/node_modules/);
      expect(testCheck?.message).not.toMatch(/tools/);
    });
  });
});

describe("unparseable tsconfig, failure in another directory (fixture: single-package-jsonc-tsconfig)", () => {
  it("stays a blocking fail: the failing path is not the declared output the precondition found missing", async () => {
    await withFixture("single-package-jsonc-tsconfig", async (repoPath, logDir) => {
      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = expectBlockingFailure(result);
      expect(testCheck?.message).toMatch(/does not name it/);
      expect(testCheck?.message).not.toMatch(/lib\/index\.js/);
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
        const result = evaluateBuildPrecondition(dir);
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
      (dir) => expect(evaluateBuildPrecondition(dir).met).toBe(false)
    );
  });

  it("is not met without a build script, however missing the artifacts are", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js" }) }, (dir) => {
      const result = evaluateBuildPrecondition(dir);
      expect(result.met).toBe(false);
      expect(result.hasBuildScript).toBe(false);
    });
  });

  it("falls back to dist/ for a package that declares no entry points at all", () => {
    withTempPackage({ "package.json": pkg({ name: "x", scripts: { build: "node build.js" } }) }, (dir) => {
      const result = evaluateBuildPrecondition(dir);
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
      (dir) => expect(evaluateBuildPrecondition(dir).met).toBe(false)
    );
  });

  it("reads the tsconfig outDir as a declared artifact", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", scripts: { build: "tsc" } }),
        "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "build" } }),
      },
      (dir) => {
        const result = evaluateBuildPrecondition(dir);
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
      (dir) => expect(evaluateBuildPrecondition(dir).met).toBe(false)
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
        const result = evaluateBuildPrecondition(dir);
        expect(result.met).toBe(true);
        expect(result.missingArtifact).toBe("./dist/index.mjs");
      }
    );
  });

  it("reads bin map values", () => {
    withTempPackage(
      { "package.json": pkg({ name: "x", scripts: { build: "tsc" }, bin: { cli: "dist/cli.js" } }) },
      (dir) => expect(evaluateBuildPrecondition(dir).missingArtifact).toBe("dist/cli.js")
    );
  });

  // A root `--workspaces --if-present` fan-out SKIPS a workspace that has no
  // build script of its own, so the build it appears to promise is a no-op
  // there; a fan-out without `--if-present` would fail outright on such a
  // workspace. Either way the workspace's own `scripts.build` is the only
  // honest test, and a workspace without one never meets the precondition.
  it("does not accept a root fan-out build script for a workspace with none of its own", () => {
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
        const result = evaluateBuildPrecondition(path.join(dir, "packages", "w"));
        expect(result.hasBuildScript).toBe(false);
        expect(result.met).toBe(false);
      }
    );
  });

  it("is met for a workspace with its own build script and a missing artifact", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "root", workspaces: ["packages/*"] }),
        "packages/w/package.json": pkg({ name: "w", main: "dist/index.js", scripts: { build: "tsc" } }),
      },
      (dir) => {
        const result = evaluateBuildPrecondition(path.join(dir, "packages", "w"));
        expect(result.hasBuildScript).toBe(true);
        expect(result.met).toBe(true);
        expect(result.missingArtifact).toBe("dist/index.js");
      }
    );
  });
});

describe("rootBuildScriptFansOutToWorkspaces (unit)", () => {
  // Used for the REMEDY only: whether the root `npm run build` that `--setup`
  // runs would reach the failing workspaces at all.
  it("recognizes the --workspaces and -ws fan-out shapes", () => {
    expect(rootBuildScriptFansOutToWorkspaces({ scripts: { build: "npm run build --workspaces --if-present" } })).toBe(true);
    expect(rootBuildScriptFansOutToWorkspaces({ scripts: { build: "npm run build -ws" } })).toBe(true);
  });

  it("does not recognize a root build of any other shape, or none at all", () => {
    expect(rootBuildScriptFansOutToWorkspaces({ scripts: { build: "tsc -b" } })).toBe(false);
    expect(rootBuildScriptFansOutToWorkspaces({ scripts: {} })).toBe(false);
    expect(rootBuildScriptFansOutToWorkspaces(undefined)).toBe(false);
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

  it("treats a preamble with the root's name but a different version as a workspace", () => {
    // The root preamble is excluded by full identity, name AND version. A line
    // whose version differs is not the root's own script line, so it stays a
    // segment rather than being silently dropped.
    const segments = splitWorkspaceSegments(workspaceRun, { name: "repo", version: "9.9.9" });
    expect(segments).toHaveLength(2);
    expect(segments?.[0].split("\n")[0]).toBe("> repo@1.2.3 test");
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

// Every case here calls the helper the way production calls it: with the
// failing package's directory AND the artifact the precondition found missing.
// An earlier round's rejection cases omitted `missingArtifact` and so never
// exercised the branch a downgrade actually goes through.
describe("findMissingArtifactEvidence (unit, the shape a downgrade is decided in)", () => {
  const repoPath = path.resolve("/repo");
  const pkgDir = path.join(repoPath, "packages", "x");
  const neighbour = path.join(repoPath, "packages", "y");
  const nested = path.join(pkgDir, "tools");
  const packageDirs = [repoPath, pkgDir, neighbour, nested];

  const decide = (output: string, missingArtifact = "dist/index.js"): string | undefined =>
    findMissingArtifactEvidence(output, { repoPath, pkgDir, missingArtifact, packageDirs });

  it("matches a package's own guard message naming the artifact by absolute path, with no Error: prefix", () => {
    // The real shape from the reported friction: a test that throws its own
    // message, printed by the runner without any Node error prefix.
    const output = `  ${path.join(pkgDir, "dist", "index.js")} is missing. Run \`npm run build\` in packages/x before testing.`;
    expect(decide(output)).toMatch(/dist\/index\.js is missing/);
  });

  it("matches a relative module-resolution failure for the artifact", () => {
    expect(decide("Error: Cannot find module './dist/index.js'")).toContain("Cannot find module");
  });

  it("matches a sibling of the declared entry point inside the same build output directory", () => {
    // An unbuilt package is missing everything under dist/, not just the one
    // path it happens to declare.
    expect(decide("Error: Cannot find module './dist/cli.js'")).toContain("./dist/cli.js");
  });

  it("matches an ENOENT open of the artifact", () => {
    expect(decide(`Error: ENOENT: no such file or directory, open '${path.join(pkgDir, "dist", "index.js")}'`)).toContain(
      "ENOENT"
    );
  });

  it("does not match a bare module specifier (an ordinary missing dependency)", () => {
    expect(decide("Error: Cannot find module 'lodash'")).toBeUndefined();
  });

  it("does not match a bare package-relative specifier, which Node resolves through node_modules", () => {
    expect(decide("Error: Cannot find module 'dist/index.js'")).toBeUndefined();
  });

  it("does not match a path under the package's own node_modules whose tail equals the artifact", () => {
    const output = `Error: Cannot find module '${path.join(pkgDir, "node_modules", "some-lib", "dist", "index.js")}'`;
    expect(decide(output)).toBeUndefined();
  });

  it("does not match an absolute path outside the repo", () => {
    expect(decide("Error: Cannot find module '/elsewhere/packages/x/dist/index.js'")).toBeUndefined();
  });

  it("does not match another workspace's artifact", () => {
    expect(decide("Error: Cannot find module '../y/dist/index.js'")).toBeUndefined();
  });

  it("does not match a nested package's artifact inside the failing package", () => {
    expect(decide(`Error: Cannot find module '${path.join(nested, "dist", "index.js")}'`)).toBeUndefined();
  });

  it("does not match a stale relative require elsewhere in the same package", () => {
    expect(decide("Error: Cannot find module './src/renamed-away.js'")).toBeUndefined();
  });

  it("does not match a runner stack frame through node_modules when the artifact is the fallback dist/", () => {
    const output = [
      "AssertionError [ERR_ASSERTION]: 2 !== 3",
      "    at Object.<anonymous> (/opt/tools/node_modules/vitest/dist/chunks/runBaseTests.js:114:5)",
      "    at file:///opt/tools/node_modules/vitest/dist/entry.js:12:9",
    ].join("\n");
    expect(decide(output, "dist")).toBeUndefined();
  });

  it("matches anything inside the fallback dist/ when that is the missing artifact", () => {
    expect(decide("Error: Cannot find module './dist/foo.js'", "dist")).toContain("./dist/foo.js");
  });

  it("matches an extensionless declaration by Node's own resolution candidates", () => {
    expect(decide("Error: Cannot find module './dist/index.js'", "./dist/index")).toContain("Cannot find module");
  });

  it("requires an exact match for an artifact declared at the package root", () => {
    // `main: "index.js"` has no build-output directory of its own, so the
    // package directory must not become the acceptance region.
    expect(decide("Error: Cannot find module './src/other.js'", "index.js")).toBeUndefined();
    expect(decide("Error: Cannot find module './index.js'", "index.js")).toContain("./index.js");
  });

  it("returns undefined for empty output", () => {
    expect(findMissingArtifactEvidence(undefined, { repoPath, pkgDir, missingArtifact: "dist/index.js" })).toBeUndefined();
  });

  it("accepts an ENOENT naming the build-output directory itself, trailing slash and all", () => {
    expect(decide("Error: ENOENT: no such file or directory, scandir './dist/'")).toContain("./dist/");
  });

  it("does not walk a pathological path token, and does not throw on one", () => {
    const token = `./${"a/".repeat(50_000)}x.js`;
    expect(() => decide(`Error: Cannot find module '${token}'`)).not.toThrow();
    expect(decide(`Error: Cannot find module '${token}'`)).toBeUndefined();
  });

  it("refuses a token past the depth bound, even one that would otherwise anchor", () => {
    // 300 segments INSIDE the missing dist/: without the bound this resolves
    // into the acceptance region and corroborates. Runner output is untrusted
    // and every resolved path is walked segment by segment, so the bound is
    // the point; the same shape just inside it still corroborates.
    expect(decide(`Error: Cannot find module './dist/${"a/".repeat(300)}x.js'`)).toBeUndefined();
    expect(decide(`Error: Cannot find module './dist/${"a/".repeat(10)}x.js'`)).toContain("Cannot find module");
  });

  it("refuses a token past the length bound, even one that would otherwise anchor", () => {
    expect(decide(`Error: Cannot find module './dist/${"a".repeat(5_000)}.js'`)).toBeUndefined();
    expect(decide(`Error: Cannot find module './dist/${"a".repeat(50)}.js'`)).toContain("Cannot find module");
  });

  it("canonicalizes an absurdly deep DECLARED artifact without blowing the stack", () => {
    // The declared artifact is repository content too (`main` in a
    // package.json), and it is canonicalized on the anchor side. No token
    // bound applies to it, so the parent walk itself has to be indifferent
    // to depth.
    const artifact = `dist/${"a/".repeat(20_000)}index.js`;
    expect(() =>
      findMissingArtifactEvidence("Error: Cannot find module './dist/index.js'", {
        repoPath,
        pkgDir,
        missingArtifact: artifact,
        packageDirs,
      })
    ).not.toThrow();
  });
});

// The absence half of the anchor rule. These use a REAL directory, because
// the rule is about what is on disk: a path inside the build-output region
// that exists cannot be evidence that a missing build broke the run, while
// the same path missing is exactly that evidence.
describe("findMissingArtifactEvidence (unit, a corroborating path must itself be absent)", () => {
  it("rejects a path in the region that is present on disk, and accepts its absent sibling", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "dist/index.js", types: "dist/index.d.ts", scripts: { build: "node build.js" } }),
        // A partially built package: dist/index.js was emitted, the declared
        // `types` never was, so `dist/index.d.ts` is the missing artifact and
        // the live dist/ is the region.
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => {
        const options = { repoPath: dir, pkgDir: dir, missingArtifact: "dist/index.d.ts", packageDirs: [dir] };

        // A genuine runtime failure's own stack frame inside the built output.
        expect(findMissingArtifactEvidence(`    at Object.add (${path.join(dir, "dist", "index.js")}:2:9)`, options)).toBeUndefined();
        // The same shape for a file that really is not there.
        expect(findMissingArtifactEvidence("Error: Cannot find module './dist/gone.js'", options)).toContain("./dist/gone.js");
        // The declared artifact itself always corroborates: the precondition
        // established it is missing before the anchor existed.
        expect(findMissingArtifactEvidence("Error: Cannot find module './dist/index.d.ts'", options)).toContain("./dist/index.d.ts");
      }
    );
  });

  it("rejects an ENOENT on the build-output directory when that directory exists", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "dist/index.js", types: "dist/index.d.ts", scripts: { build: "node build.js" } }),
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => {
        const evidence = findMissingArtifactEvidence("Error: ENOENT: no such file or directory, scandir './dist/'", {
          repoPath: dir,
          pkgDir: dir,
          missingArtifact: "dist/index.d.ts",
          packageDirs: [dir],
        });
        expect(evidence).toBeUndefined();
      }
    );
  });
});

// The second, message-only mode: no artifact to anchor to (the precondition
// already decided this unit blocks), so the question is only "did this package
// report a missing file of its own worth quoting". It can never reach a
// downgrade, but it must not quote someone else's problem as this package's.
describe("findMissingArtifactEvidence (unit, message-only observation mode)", () => {
  const repoPath = path.resolve("/repo");
  const pkgDir = path.join(repoPath, "packages", "x");
  const nested = path.join(pkgDir, "tools");
  const observe = (output: string): string | undefined =>
    findMissingArtifactEvidence(output, { repoPath, pkgDir, packageDirs: [repoPath, pkgDir, nested] });

  it("quotes a missing path inside the failing package, wherever in it", () => {
    expect(observe("Error: Cannot find module './src/renamed-away.js'")).toContain("./src/renamed-away.js");
  });

  it("does not quote a path under the package's own node_modules", () => {
    expect(observe(`Error: Cannot find module '${path.join(pkgDir, "node_modules", "lib", "dist", "index.js")}'`)).toBeUndefined();
  });

  it("does not quote a nested package's path", () => {
    expect(observe(`Error: Cannot find module '${path.join(nested, "dist", "index.js")}'`)).toBeUndefined();
  });

  it("does not quote a path outside the repo", () => {
    expect(observe("Error: Cannot find module '/elsewhere/lib/index.js'")).toBeUndefined();
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

describe("evaluateBuildRequiredTestFailure, hostile and awkwardly spelled input (unit)", () => {
  it("answers a pathological path token instead of throwing out of the evaluation", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }) }, (dir) => {
      const token = `./${"a/".repeat(50_000)}x.js`;
      const result = evaluateBuildRequiredTestFailure({
        repoPath: dir,
        output: `Error: Cannot find module '${token}'`,
      });

      // No corroboration, so the already-failing check keeps blocking, and
      // the evaluation returns rather than taking the run down with it.
      expect(result.downgrade).toBe(false);
      expect(result.limitation).toBeUndefined();
    });
  });

  it("returns a blocking evaluation, never a throw, however the corroboration ends", () => {
    // Both guards meet here: the corroboration is asked about an absurdly
    // deep declared artifact, and whatever it does the caller must come back
    // with a verdict. An escaped exception at this call site is what killed a
    // whole `preflight run` and left it with no JSON at all.
    const main = `dist/${"a/".repeat(20_000)}index.js`;
    withTempPackage({ "package.json": pkg({ name: "x", main, scripts: { build: "tsc" } }) }, (dir) => {
      let result: ReturnType<typeof evaluateBuildRequiredTestFailure> | undefined;
      expect(() => {
        result = evaluateBuildRequiredTestFailure({
          repoPath: dir,
          output: "Error: Cannot find module './dist/index.js'",
        });
      }).not.toThrow();
      expect(result?.downgrade).toBe(false);
    });
  });

  it("names the missing artifact relative to the repo path as the caller spelled it", () => {
    withTempPackage({ "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "tsc" } }) }, (dir) => {
      // A repo reached through a symlink: paths the runner prints resolve to
      // the physical directory, but the message belongs to the operator's
      // spelling. Canonicalization stays inside the corroboration.
      const link = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-link-")) + "/repo";
      fs.symlinkSync(dir, link);
      try {
        const result = evaluateBuildRequiredTestFailure({
          repoPath: link,
          output: "Error: Cannot find module './dist/index.js'",
        });
        expect(result.downgrade).toBe(true);
        expect(result.cause).toContain("(dist/index.js)");
        expect(result.cause).not.toContain("..");
      } finally {
        fs.rmSync(path.dirname(link), { recursive: true, force: true });
      }
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
