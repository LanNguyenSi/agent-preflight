import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import * as fs from "fs";
// The same default import `src/checks/shared.ts` uses. A namespace import
// cannot be spied on (an ESM namespace is not configurable), while the default
// export of a CJS builtin is the very object that module reaches through, so a
// spy on it is visible to the code under test.
import fsDefault from "fs";
import * as os from "os";
import { execSync } from "child_process";
import { runPreflight } from "../src/runner.js";
import {
  evaluateBuildPrecondition,
  evaluateBuildRequiredTestFailure,
  evaluatePartialBuild,
  findMissingArtifactEvidence,
  rootBuildScriptFansOutToWorkspaces,
  splitWorkspaceSegments,
  workflowTextShowsBuildBeforeTest,
} from "../src/checks/shared.js";
import type { BuildRequiredEvaluation } from "../src/checks/shared.js";

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
// frame pointing into it. What separates that from a missing build is the
// state of the build-output directory itself: unbuilt, dist/ is not there;
// after the build it holds entries, and an output directory holding entries
// means a build ran and simply did not produce the declared artifact.
//
// These two fixtures are asserted in both states, and the states differ:
// before any build the package genuinely is unbuilt (no dist/ at all), so the
// named skip is correct; after a successful build the same failure is a
// blocker, and stays one however often the build is repeated.
describe("partially built package, declared `types` never emitted (fixture: single-package-partial-build-types)", () => {
  it("is the named skip while nothing is built, and a blocking fail once dist/ holds the build", async () => {
    await withFixture("single-package-partial-build-types", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);
      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "index.d.ts"))).toBe(false);

      const first = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(first)?.status).toBe("fail");
      expect(testCheckOf(first)?.message).not.toMatch(/build required before test/);
      // This failure is a genuine bug inside the live dist/, so the only path
      // it names IS on disk and nothing in the package's output is blamed. The
      // message therefore stays the plain one: the artifact is missing and the
      // failure does not name it. Explaining a partially built output
      // directory here would answer a question the failure never asked.
      expect(testCheckOf(first)?.message).toMatch(
        /a declared build artifact \(dist\/index\.d\.ts\) is missing, but the failure in this repo does not name it/
      );
      expect(testCheckOf(first)?.message).not.toMatch(/exists and is not empty/);
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
  it("is the named skip while nothing is built, and a blocking fail once dist/ holds the build", async () => {
    await withFixture("single-package-partial-build-exports", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);
      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "extra.js"))).toBe(false);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      // As in the `types` fixture above: the regression is inside the live
      // dist/index.js, so the failure names only a path that is on disk and
      // the plain sentence applies.
      expect(testCheck?.message).toMatch(
        /a declared build artifact \(dist\/extra\.js\) is missing, but the failure in this repo does not name it/
      );
      expect(testCheck?.message).not.toMatch(/exists and is not empty/);
      expect(result.ready).toBe(false);
      expect(result.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// The two shapes that read the WRONG directory while "partially built" was
// decided from the missing artifact's own dirname: a declaration in a NESTED
// output directory, and a second `exports` target in a different directory
// altogether. In both, the build fills one directory the package declares and
// never fills the other, so the missing artifact's own directory is absent
// while the package is plainly built. Deciding it as a package property -- any
// output directory this package identifies holding an entry -- is what
// separates them from a genuinely unbuilt checkout, which is why both are
// asserted in BOTH states.
describe("nested artifact directory beside a populated one (fixture: single-package-nested-artifact-dir)", () => {
  it("is the named skip while nothing is built, and a blocking fail once dist/ holds the build", async () => {
    await withFixture("single-package-nested-artifact-dir", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);

      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(testCheckOf(unbuilt)?.message).toMatch(/build required before test/);
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build", { cwd: repoPath });
      expect(fs.readdirSync(path.join(repoPath, "dist"))).toEqual(["index.js"]);
      expect(fs.existsSync(path.join(repoPath, "dist", "types"))).toBe(false);

      const built = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      const testCheck = testCheckOf(built);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      // The directory that decided it is the populated dist/, not the absent
      // dist/types/ the missing artifact sits in.
      expect(testCheck?.message).toMatch(
        /build output directory \(dist\) of this repo exists and is not empty/
      );
      expect(testCheck?.message).toMatch(/dist\/types\/index\.d\.ts/);
      // The message names the remedy rather than only refusing the downgrade.
      expect(testCheck?.message).toMatch(/rerun the build and preflight if this output is stale/);
      expect(built.ready).toBe(false);
      expect(built.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);

      // Sticky: a second build cannot emit the declaration either.
      execSync("npm run build", { cwd: repoPath });
      const again = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(again)?.status).toBe("fail");
      expect(again.ready).toBe(false);
    });
  });
});

describe("a second declared output directory (fixture: single-package-second-output-dir)", () => {
  it("is the named skip while nothing is built, and a blocking fail once the first directory holds the build", async () => {
    await withFixture("single-package-second-output-dir", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);
      expect(fs.existsSync(path.join(repoPath, "lib"))).toBe(false);

      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(testCheckOf(unbuilt)?.message).toMatch(/build required before test/);
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build", { cwd: repoPath });
      expect(fs.readdirSync(path.join(repoPath, "dist"))).toEqual(["index.js"]);
      expect(fs.existsSync(path.join(repoPath, "lib"))).toBe(false);

      const built = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      const testCheck = testCheckOf(built);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      // The populated directory and the missing artifact are in DIFFERENT
      // directories here, and the message names both.
      expect(testCheck?.message).toMatch(
        /build output directory \(dist\) of this repo exists and is not empty/
      );
      expect(testCheck?.message).toMatch(/lib\/styles\.css/);
      expect(built.ready).toBe(false);
      expect(built.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

// The three shapes the round-5 review reproduced as a sticky false green: a
// package whose declared artifact the build NEVER emits keeps the filesystem
// precondition met permanently, and its own failure names either that absent
// artifact (the exact arm) or an absent sibling inside the populated dist/
// (the region arm). Both corroborated, so the check reported `ready: true`
// and stayed there after a successful `npm run build`. The emptiness rule is
// what ends that: after the build the output directory holds entries, so no
// path corroborates and the failure is reported as the real failure it is.
//
// Each is asserted in BOTH states, because the after-build state is the one
// that used to be wrong and the before-build state is the motivating case
// this feature exists for (no dist/ at all, so the skip is correct there).
describe("declared `bin` the build never emits (fixture: single-package-bin-never-emitted)", () => {
  it("is the named skip while nothing is built, and a blocking fail once dist/ holds the rest of the build", async () => {
    await withFixture("single-package-bin-never-emitted", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);

      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "cli.js"))).toBe(false);

      const built = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      const testCheck = testCheckOf(built);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      expect(testCheck?.message).toMatch(
        /build output directory \(dist\) of this repo exists and is not empty/
      );
      expect(testCheck?.message).toMatch(/dist\/cli\.js/);
      expect(built.ready).toBe(false);
      expect(built.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

describe("stale `types` plus an asset the build never copies (fixture: single-package-partial-build-uncopied-asset)", () => {
  it("is the named skip while nothing is built, and a blocking fail once dist/ holds the build", async () => {
    await withFixture("single-package-partial-build-uncopied-asset", async (repoPath, logDir) => {
      expect(fs.existsSync(path.join(repoPath, "dist"))).toBe(false);

      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build", { cwd: repoPath });
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, "dist", "index.d.ts"))).toBe(false);
      expect(fs.existsSync(path.join(repoPath, "dist", "templates"))).toBe(false);

      const built = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      const testCheck = testCheckOf(built);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      expect(testCheck?.message).toMatch(
        /build output directory \(dist\) of this repo exists and is not empty/
      );
      expect(built.ready).toBe(false);
      expect(built.blockers.some((b) => b.startsWith("npm test failed"))).toBe(true);
    });
  });
});

describe("the same partial build as a workspace under a root fan-out (fixture: monorepo-partial-build-uncopied-asset)", () => {
  it("is the named skip while nothing is built, and a blocking fail after the root build, twice over", async () => {
    await withFixture("monorepo-partial-build-uncopied-asset", async (repoPath, logDir) => {
      const workspace = path.join(repoPath, "packages", "renderer");
      expect(fs.existsSync(path.join(workspace, "dist"))).toBe(false);

      const unbuilt = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(unbuilt)?.status).toBe("skip");
      expect(unbuilt.ready).toBe(true);

      execSync("npm run build --workspaces --if-present", { cwd: repoPath });
      expect(fs.existsSync(path.join(workspace, "dist", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(workspace, "dist", "index.d.ts"))).toBe(false);

      const built = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      const testCheck = testCheckOf(built);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).not.toMatch(/build required before test/);
      expect(testCheck?.message).toMatch(
        /build output directory \(packages\/renderer\/dist\) of workspace `fixture-renderer` exists and is not empty/
      );
      expect(built.ready).toBe(false);

      // Sticky check: repeating the build cannot create the missing artifact,
      // so the verdict must not drift back to a skip.
      execSync("npm run build --workspaces --if-present", { cwd: repoPath });
      const again = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });
      expect(testCheckOf(again)?.status).toBe("fail");
      expect(again.ready).toBe(false);
    });
  });
});

// The other side of the emptiness rule: an output directory that EXISTS but
// holds nothing is still "not built yet" -- a `mkdir dist` a tool left behind,
// or a build that was interrupted before writing anything.
describe("empty build output directory (fixture: single-package-empty-build-output)", () => {
  it("is the named skip: an existing but empty dist/ is still an unbuilt package", async () => {
    await withFixture("single-package-empty-build-output", async (repoPath, logDir) => {
      // Made here rather than checked in: git cannot carry an empty directory.
      fs.mkdirSync(path.join(repoPath, "dist"));
      expect(fs.readdirSync(path.join(repoPath, "dist"))).toEqual([]);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/build required before test/);
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
    });
  });

  it("blocks once that directory holds a single placeholder file: ANY entry counts", async () => {
    await withFixture("single-package-empty-build-output", async (repoPath, logDir) => {
      fs.mkdirSync(path.join(repoPath, "dist"));
      fs.writeFileSync(path.join(repoPath, "dist", ".gitkeep"), "");

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(
        /build output directory \(dist\) of this repo exists and is not empty/
      );
      expect(result.ready).toBe(false);
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
      // The checked-in `lib/.keep` exists only so git can carry the empty
      // output directory at all. An unbuilt package's output directory is
      // empty, so it is removed here; a placeholder left in place makes the
      // package read as partially built instead, which the next test pins.
      fs.rmSync(path.join(repoPath, "lib", ".keep"));
      expect(fs.lstatSync(path.join(repoPath, "dist")).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(path.join(repoPath, "lib"))).toEqual([]);
      expect(fs.existsSync(path.join(repoPath, "dist", "index.js"))).toBe(false);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("skip");
      expect(testCheck?.message).toMatch(/build required before test/);
      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
    });
  });

  // The documented cost of "any entry counts": a placeholder checked into the
  // output directory (a `.keep`, a `.gitignore`) makes an otherwise unbuilt
  // package read as partially built, so its failure blocks. The remedy is the
  // same build, and blocking is the safe direction; the rule stays this simple
  // on purpose, rather than guessing which files are "real" build output.
  it("blocks while a checked-in placeholder makes the output directory non-empty", async () => {
    await withFixture("single-package-symlinked-dist", async (repoPath, logDir) => {
      expect(fs.readdirSync(path.join(repoPath, "lib"))).toEqual([".keep"]);

      const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

      const testCheck = testCheckOf(result);
      expect(testCheck?.status).toBe("fail");
      expect(testCheck?.message).toMatch(
        /build output directory \(dist\) of this repo exists and is not empty/
      );
      expect(result.ready).toBe(false);
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

// The package-level partial-build rule, and the absence rule underneath it.
// These use a REAL directory, because both rules are about what is on disk,
// and they go through `evaluateBuildRequiredTestFailure` because that is where
// the two are combined into the verdict.
describe("the package-level partial-build rule (unit)", () => {
  // A partially built package: dist/index.js was emitted, the declared `types`
  // never was, so `dist/index.d.ts` is the missing artifact and the live dist/
  // is what the tests load.
  const partiallyBuilt = {
    "package.json": pkg({ name: "x", main: "dist/index.js", types: "dist/index.d.ts", scripts: { build: "node build.js" } }),
    "dist/index.js": "module.exports = {};\n",
  };

  const classify = (dir: string, output: string): BuildRequiredEvaluation =>
    evaluateBuildRequiredTestFailure({ repoPath: dir, output });

  it("refuses every downgrade once the package holds build output, the missing artifact included", () => {
    withTempPackage(partiallyBuilt, (dir) => {
      // A genuine runtime failure's own stack frame inside the built output.
      expect(classify(dir, `    at Object.add (${path.join(dir, "dist", "index.js")}:2:9)`).downgrade).toBe(false);
      // An absent sibling inside the same populated dist/ (an asset the build
      // never copies): corroborated before this rule, refused now.
      expect(classify(dir, "Error: Cannot find module './dist/gone.js'").downgrade).toBe(false);
      // The declared artifact itself, which the build never emits.
      const artifact = classify(dir, "Error: Cannot find module './dist/index.d.ts'");
      expect(artifact.downgrade).toBe(false);
      expect(artifact.note).toMatch(/build output directory \(dist\) of this repo exists and is not empty/);
      expect(artifact.note).toMatch(/rerun the build and preflight if this output is stale/);
      // And an ENOENT naming the output directory itself.
      expect(classify(dir, "Error: ENOENT: no such file or directory, scandir './dist/'").downgrade).toBe(false);
    });
  });

  it("reads EVERY output directory the package declares, not just the missing artifact's own", () => {
    // dist/ is built and lib/ never is, so the missing artifact's own
    // directory is absent while the package is plainly built.
    withTempPackage(
      {
        "package.json": pkg({
          name: "x",
          exports: { ".": "./dist/index.js", "./styles": "./lib/styles.css" },
          scripts: { build: "node build.js" },
        }),
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => {
        const result = classify(dir, "Error: ENOENT: no such file or directory, open './lib/styles.css'");
        expect(result.downgrade).toBe(false);
        // The message names the directory that decided it and the artifact
        // that is missing, which here are two different directories.
        expect(result.note).toMatch(/build output directory \(dist\) of this repo exists and is not empty/);
        expect(result.note).toMatch(/lib\/styles\.css/);
      }
    );
  });

  it("reads a LATER declared artifact's directory too, not only the first", () => {
    // The two fixtures above happen to declare the built artifact first, so a
    // reading that stops at the first declared artifact still finds the
    // populated directory there and looks correct. Here the order is the other
    // way round: the first declaration's directory is absent and the second
    // one holds the build. Only reading all of them separates this from an
    // unbuilt package (measured: a `slice(0, 1)` mutant survives without this
    // case).
    withTempPackage(
      {
        "package.json": pkg({
          name: "x",
          main: "build/index.js",
          types: "dist/index.d.ts",
          scripts: { build: "node build.js" },
        }),
        "dist/other.js": "module.exports = {};\n",
      },
      (dir) => {
        const state = evaluatePartialBuild(dir);
        expect(state.partiallyBuilt).toBe(true);
        expect(state.evidence?.dir).toBe("dist");
        expect(classify(dir, "Error: Cannot find module './build/index.js'").downgrade).toBe(false);
      }
    );
  });

  it("reads a nested artifact directory the same way", () => {
    withTempPackage(
      {
        "package.json": pkg({
          name: "x",
          main: "dist/index.js",
          types: "dist/types/index.d.ts",
          scripts: { build: "node build.js" },
        }),
        "dist/index.js": "module.exports = {};\n",
      },
      (dir) => {
        const result = classify(dir, "Error: Cannot find module './dist/types/index.d.ts'");
        expect(result.downgrade).toBe(false);
        expect(result.note).toMatch(/build output directory \(dist\) of this repo exists and is not empty/);
        expect(result.note).toMatch(/dist\/types\/index\.d\.ts/);
      }
    );
  });

  it("still downgrades while every directory the package identifies is absent or empty", () => {
    withTempPackage(
      {
        "package.json": pkg({
          name: "x",
          main: "dist/index.js",
          types: "types/index.d.ts",
          scripts: { build: "node build.js" },
        }),
      },
      (dir) => {
        fs.mkdirSync(path.join(dir, "dist"));
        expect(evaluatePartialBuild(dir).partiallyBuilt).toBe(false);
        expect(classify(dir, "Error: Cannot find module './dist/index.js'").downgrade).toBe(true);
        expect(classify(dir, "Error: Cannot find module './dist/cli.js'").downgrade).toBe(true);
      }
    );
  });

  it("says what it observed when the output path is a FILE, instead of claiming entries", () => {
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "node build.js" } }),
        dist: "not a directory\n",
      },
      (dir) => {
        const result = classify(dir, "Error: Cannot find module './dist/index.js'");
        expect(result.downgrade).toBe(false);
        expect(result.note).toMatch(/build output directory \(dist\) of this repo could not be read \(ENOTDIR\)/);
        expect(result.note).not.toMatch(/exists and is not empty/);
      }
    );
  });

  it("keeps the plain sentence when a partially built package's failure names nothing in its output", () => {
    withTempPackage(partiallyBuilt, (dir) => {
      const result = classify(dir, "AssertionError [ERR_ASSERTION]: 2 !== 3");
      expect(result.downgrade).toBe(false);
      expect(result.note).toMatch(/a declared build artifact \(dist\/index\.d\.ts\) is missing, but the failure in this repo does not name it/);
      expect(result.note).not.toMatch(/exists and is not empty/);
    });
  });

  it("falls back to dist/ for a package that identifies no output directory of its own", () => {
    // `main: "index.js"` has no build-output directory: its "directory" is the
    // package, and a whole package is not build output. The conventional dist/
    // decides instead, so the rule cannot be switched off by declaring an
    // artifact at the package root.
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "index.js", scripts: { build: "node build.js" } }),
        "dist/left-over.js": "module.exports = {};\n",
      },
      (dir) => {
        const state = evaluatePartialBuild(dir);
        expect(state.partiallyBuilt).toBe(true);
        expect(state.evidence?.dir).toBe("dist");
        expect(classify(dir, "Error: Cannot find module './index.js'").downgrade).toBe(false);
      }
    );
  });

  it("does not read a directory outside the package, however the package spells it", () => {
    // A `dist` symlinked out of the package names someone else's directory,
    // and what is in there says nothing about this package.
    withTempPackage(
      {
        "package.json": pkg({ name: "x", main: "dist/index.js", scripts: { build: "node build.js" } }),
        "outside/other.js": "module.exports = {};\n",
      },
      (dir) => {
        const real = fs.realpathSync(dir);
        fs.mkdirSync(path.join(real, "pkg"));
        fs.writeFileSync(
          path.join(real, "pkg", "package.json"),
          pkg({ name: "y", main: "dist/index.js", scripts: { build: "node build.js" } })
        );
        fs.symlinkSync(path.join(real, "outside"), path.join(real, "pkg", "dist"));

        expect(evaluatePartialBuild(path.join(real, "pkg")).partiallyBuilt).toBe(false);
      }
    );
  });

  it("keeps the absence rule as an independent floor when the directory read is blinded", () => {
    // The two rules answer different questions -- "has this package been built
    // at all" and "can THIS path be evidence of a missing build" -- and the
    // second must not quietly depend on the first. With the directory read
    // reporting an empty dist/ (a race, or a future relaxation of the rule), a
    // path that IS on disk still does not corroborate.
    withTempPackage(partiallyBuilt, (dir) => {
      const realReaddir = fsDefault.readdirSync;
      const spy = vi
        .spyOn(fsDefault, "readdirSync")
        .mockImplementation(((target: fs.PathLike, options?: unknown) =>
          String(target).endsWith(`${path.sep}dist`)
            ? []
            : (realReaddir as (a: fs.PathLike, b?: unknown) => unknown)(target, options)) as typeof fs.readdirSync);
      try {
        expect(classify(dir, `    at Object.add (${path.join(dir, "dist", "index.js")}:2:9)`).downgrade).toBe(false);
        // Control: with the directory read blinded, an ABSENT path in the same
        // region does corroborate again, so the rejection above is the absence
        // rule's doing and not a side effect of the mock.
        expect(classify(dir, "Error: Cannot find module './dist/gone.js'").downgrade).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
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

  // The guard around every corroboration call, and the limitation it records.
  // Both were unpinned: a probe deleting the `limitations.push` survived the
  // whole suite, because no test ever made the corroboration throw. The
  // existence test inside the anchor rule is the one unguarded filesystem call
  // on that path, so a spy that throws exactly for the path the corroboration
  // asks about (and nothing else) reproduces the state the guard exists for.
  const throwingExistsSyncFor = (tail: string): { restore: () => void } => {
    const realExistsSync = fsDefault.existsSync;
    const spy = vi.spyOn(fsDefault, "existsSync").mockImplementation(((target: fs.PathLike) => {
      if (String(target).endsWith(tail)) throw new Error("boom: existsSync refused");
      return (realExistsSync as (a: fs.PathLike) => boolean)(target);
    }) as typeof fs.existsSync);
    return { restore: () => spy.mockRestore() };
  };

  it("records a limitation and keeps blocking when the corroboration throws", () => {
    withTempPackage(
      {
        "package.json": pkg({
          name: "x",
          main: "dist/index.js",
          bin: { mytool: "dist/cli.js" },
          scripts: { build: "node build.js" },
        }),
      },
      (dir) => {
        // `dist/index.js` is the missing artifact the precondition finds first,
        // so nothing before the corroboration asks about `dist/cli.js`.
        const spy = throwingExistsSyncFor(path.join("dist", "cli.js"));
        try {
          const result = evaluateBuildRequiredTestFailure({
            repoPath: dir,
            output: "Error: Cannot find module './dist/cli.js'",
          });

          expect(result.downgrade).toBe(false);
          expect(result.limitation).toBeTruthy();
          expect(result.limitation).toContain("boom: existsSync refused");
          expect(result.limitation).toContain("reported as a blocker");
        } finally {
          spy.restore();
        }
      }
    );
  });

  it("surfaces that limitation through runTestChecks into the run's limitations", async () => {
    // The same throw one level up: `runPreflight` must report the unanswered
    // classification, not swallow it. Without the fixture's own dist/ the
    // failure would otherwise be the named skip, so the limitation is the only
    // thing that says why this is a blocker instead.
    await withFixture("single-package-bin-never-emitted", async (repoPath, logDir) => {
      const spy = throwingExistsSyncFor(path.join("dist", "cli.js"));
      try {
        const result = await runPreflight(repoPath, { checks: TEST_ONLY_CHECKS, logDir });

        expect(testCheckOf(result)?.status).toBe("fail");
        expect(result.ready).toBe(false);
        expect(
          result.limitations.some(
            (limitation) =>
              limitation.includes("Build-required classification not evaluated") &&
              limitation.includes("boom: existsSync refused")
          )
        ).toBe(true);
      } finally {
        spy.restore();
      }
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
