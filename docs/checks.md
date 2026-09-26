# Checks reference

Every check `agent-preflight` can run, what it verifies, and when it fires. Each check returns a `pass`, `fail`, `warn`, or `skip` and contributes to the overall confidence score (see [confidence-scoring.md](./confidence-scoring.md)).

## Default checks

| Check | Kind | What it catches | Tools tried | Status semantics |
|-------|------|-----------------|-------------|------------------|
| Git state, clean worktree | `git-state` | Tracked or untracked local changes that would diverge from what gets pushed | `git status --porcelain`, `git status --porcelain -z` | `fail` (blocker) when dirty; under `--setup`, judged against a snapshot taken before setup ran, so setup's own install/build output is never the reason for a `fail` (see "Setup phase" below) |
| Git state, protected branch | `git-state` | Pushing directly to `main`, `master`, or other configured branches | `git rev-parse --abbrev-ref HEAD` | `warn`, since some workflows allow direct push |
| Lint | `lint` | Code-quality issues | `eslint`, `ruff`, `pint`, `phpcs`, plus `package.json` `scripts.lint` and other repo-native scripts (Java has no default linter; set `commands.lint`) | `fail` on lint errors |
| Typecheck | `typecheck` | Type errors and broken builds | `tsc --noEmit`, `mypy`, `phpstan`, `psalm`, `mvn compile`, `gradle classes` | `fail` on type errors |
| Test | `test` | Broken test suites | `npm test`, `pytest`, `phpunit`, `mvn test`, `gradle test` | `fail` when tests fail; `skip` for the auto-detected `npm test` when every failing package is unbuilt on disk (it has a `build` script of its own, a declared artifact is missing), holds no build output at all, and its own output names a path that resolves either to that missing artifact itself or to something in the missing artifact's directory that is likewise NOT on disk. "Holds no build output" is a PACKAGE property: every output directory the package identifies (the directory of each declared artifact, plus `dist` when it identifies none) is absent or empty. Any entry in any of them means a build ran and did not produce the artifact, so a partially built package (one declared artifact its build never emits, the rest built -- including one emitted into a different or nested directory) stays a blocking `fail` whose message names the directory that decided it, the artifact, and the rebuild remedy; a stale partial output directory is included. See ["Build-required test classification"](#build-required-test-classification-an-unbuilt-package-is-not-a-broken-one) below |
| Dependency audit | `audit` | Known CVEs in dependencies | `npm audit --json`, `pip-audit`, `composer audit` | `fail` on high-severity findings; `skip` with a limitation when npm returned no report (including a timeout) |
| Secret detection | `secret-detection` | API keys, tokens, private keys in source files | regex scan, git-aware + diff-scoped severity | `fail` only when the current change introduced the secret; `warn` for pre-existing, gitignored, docs, or non-git |
| Commit convention | `commit-convention` | Recent commit messages that do not follow conventional commits | `git log` | `warn` only |
| TDD signal | `tdd` | Source files changed in the last commit without a paired test file | `git diff HEAD~1..HEAD`, filesystem scan | `warn` to nudge, never blocks; associates filenames only, it does not establish coverage or prove a TDD workflow |
| CI simulation (opt-in) | `ci-simulation` | Workflow failures before push | `act` against `.github/workflows/` | `fail` when act exits non-zero |
| Custom checks | `custom` | Anything you can express as a shell command | user-provided `command` | `fail` or `warn` per `failOnError` |

## Status semantics

- `pass` and `skip` never block.
- `warn` shows in output but does not move `ready` to `false`.
- `fail` is a blocker, `ready` becomes `false`, and the CLI exits non-zero.
- `acknowledged` is a `fail` the operator explicitly waived via
  `checks.<kind>.acknowledge` in `.preflight.json`: never blocks, but
  stays visible with its own status and the waiver's reason (see
  ["Waiving a permanently-failing
  check"](#waiving-a-permanently-failing-check-checksacknowledge)
  below).

`clean-worktree` is a blocker because local modifications make the result diverge from what will actually be pushed. `protected-branch` is a warning because direct-push workflows still exist. Under `--setup`, `clean-worktree` still blocks on any change that predates setup, and still blocks on a tracked file setup modifies or removes; only untracked output setup itself produced is excused (named in the check's `details`, shown by `--json` and MCP, and in a `limitations` entry shown by the CLI, instead of blocking) -- see "Setup phase" below.

## Auto-detection

If no `commands.*` entries are configured, the runner walks the repo root for known manifests and picks defaults:

- Node, TypeScript: `package.json`, `tsconfig.json`
- Python: `pyproject.toml`, `setup.py`, `requirements.txt`
- PHP: `composer.json` (Symfony repos use this generic PHP path; the check runners have no Symfony-specific branch, so Symfony is only detected for sandbox image profiles, see [architecture.md](./architecture.md#sandbox))
- Java: Maven (`pom.xml`) or Gradle (`build.gradle`, `build.gradle.kts`) manifests

Unknown stacks emit a `limitation` rather than a `fail`, so the runner still produces a score. See [confidence-scoring.md](./confidence-scoring.md) for how skips and limitations affect the result.

For Node projects, `package.json` `scripts.lint` takes precedence over dependency detection. If ESLint is only detected as a dependency, the runner invokes it only when the repository root contains a supported flat `eslint.config.*` or legacy `.eslintrc*` file. Otherwise it reports the missing ESLint configuration as a limitation and does not run ESLint.

The `npm-audit` check runs with a bounded timeout, and an audit that did not answer is reported as `skip` (not `warn`) with a `limitations` entry naming the cause: a timeout with no parsable report, or npm exiting non-zero without producing a report, which is what an unreachable or failing registry produces. That is the default direction rather than a list of recognized registry errors, so an outage never hangs the run, and an unfamiliar failure degrades to "not evaluated" instead of being misread as a real finding. npm's own usage errors, such as a missing lockfile, name themselves in `error.code` and stay a `warn` naming that failure.

For a direct nested target or `workingDir`, the TDD signal check evaluates changed sources and their test counterparts relative to that directory; sources in sibling packages (including similarly prefixed paths) are outside that target.

## Monorepos and workspaces

For npm, yarn, or pnpm workspace layouts where the root has no `tsconfig.json` or `.eslintrc` (per-package configs live under `packages/*` or `apps/*`), declare `scripts.typecheck` and `scripts.lint` in the root `package.json` that fan out to the workspaces. `agent-preflight` prefers these over root-level tool detection:

```json
{
  "name": "my-monorepo",
  "private": true,
  "workspaces": ["backend", "frontend", "mcp-server"],
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present"
  }
}
```

This way a per-package type error surfaces as a real `fail`, not a silent `limitation`. For pnpm, use `pnpm -r typecheck`. For yarn, `yarn workspaces foreach run typecheck`. Use `commands.*` in `.preflight.json` if you need a different invocation.

## Toggles

Every check can be turned off in `.preflight.json`:

```json
{
  "checks": {
    "gitState": true,
    "lint": true,
    "typecheck": true,
    "test": true,
    "audit": true,
    "ciSimulation": false,
    "commitConvention": true,
    "secretDetection": true,
    "tdd": true
  },
  "protectedBranches": ["main", "master", "develop"],
  "commitConvention": "conventional"
}
```

CLI flags `--no-audit`, `--no-secrets`, and `--ci-simulation` override the file for one run.

Instead of `true`/`false`, any toggle except `ciSimulation` and
`secretDetection` can also be `{ "acknowledge": "<reason>" }` to run the
check but waive a `fail` result as a non-blocking `acknowledged` status
with the reason attached: see ["Waiving a permanently-failing
check"](#waiving-a-permanently-failing-check-checksacknowledge) below
for the full contract (required non-empty reason, visibility guarantees,
boundaries, and why `secretDetection` is excluded).

### Failure log directory override

`logDir` in `.preflight.json` overrides where a failing lint/typecheck/test/audit/custom check's complete stdout+stderr is persisted, in place of the default `~/.agent-preflight/logs`:

```json
{
  "logDir": ".preflight-logs"
}
```

A relative value resolves against the repo root (not `workingDir`, not `process.cwd()`); a leading `~/` expands to the home directory; an absolute path is used as-is. If the chosen directory lives inside the repo, add it to `.gitignore`: an un-ignored `logDir` fills the working tree with untracked log files and trips the `clean-worktree` check on the next run.

`logDir` is not the only way to set this: the `PREFLIGHT_LOG_DIR` environment variable is a second, lower-precedence override, useful for a run against a scratch fixture, or for a parallel `preflight` worktree that shares `$HOME` with other checkouts on the same machine. The log directory is resolved in this order:

| precedence | source | notes |
| --- | --- | --- |
| 1 (highest) | `logDir` in `.preflight.json` | a relative path resolves against the repo root, not `workingDir` and not the process's cwd; a leading `~/` is expanded to the home directory |
| 2 | `PREFLIGHT_LOG_DIR` environment variable | a leading `~/` is expanded to the home directory, same as level 1; only an absolute path (after that expansion) is honored, a value that is still relative once expanded, or empty, or whitespace-only, is ignored with a warning naming the variable, and resolution falls through to level 3; resolved once when the run starts, whether or not any check ends up failing, not lazily on the first failure |
| 3 (default) | `~/.agent-preflight/logs` | `os.homedir()`-based default |

Since the log directory can be set from the process environment as well as from `.preflight.json`, it is worth noting what lands there: `preflight` creates it (`mkdir -p`) if missing, writes one file per failing check, and rotates old files out of it (unlinking any file matching its own naming scheme, described below, once more than 20 accumulate), so point it at a directory this process is meant to own rather than one shared with unrelated data. If the resolved log directory (from `logDir` or `PREFLIGHT_LOG_DIR`) points inside the repo itself, as the `.preflight-logs` example above does, add that directory to `.gitignore`: otherwise the log files it fills up show up as untracked changes, and the *next* run's own `clean-worktree` check fails on them. The pid and per-process sequence number together keep two failures of the same check from colliding even at the identical millisecond, whether they come from the same process or two concurrent `preflight` runs sharing a log directory. Only the 20 newest files matching this feature's own naming scheme (`<check>-<epoch-ms>[-<pid>]-<sequence>.log`; the pid segment is optional so log files written before it existed are still recognized and drained instead of accumulating forever) are kept: any other file dropped into that directory by another tool is left untouched. The check's `details` lead with `full output: <path>` plus up to 10 parsed vitest/jest failure lines so consumers can name the failing tests without re-running the suite. A failed log write silently falls back to the previous first-10-lines detail behavior; it never affects the check result.

## Configuration reference

`.preflight.json` in the repo root, all keys optional:

```json
{
  "workingDir": ".",
  "checks": {
    "gitState": true,
    "lint": true,
    "typecheck": true,
    "test": true,
    "audit": true,
    "ciSimulation": false,
    "commitConvention": true,
    "secretDetection": true,
    "tdd": true
  },
  "protectedBranches": ["main", "master"],
  "logDir": ".preflight-logs",
  "secretDetectionStrict": false,
  "secretAllowlist": ["fixtures/*", "src/config.ts:42"],
  "tddExceptions": ["src/generated/**"],
  "setup": { "enabled": false, "buildTimeoutMs": 300000 },
  "commands": {
    "lint": ["npm run lint"],
    "typecheck": ["npx tsc --noEmit"],
    "test": ["npm run test"],
    "audit": ["npm audit --json"]
  },
  "commitConvention": "conventional",
  "actFlags": ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"],
  "sandbox": {
    "aptPackages": ["php-imagick"],
    "pipPackages": ["bandit"]
  },
  "customChecks": [
    { "name": "smoke", "command": "make smoke", "failOnError": false }
  ]
}
```

`workingDir` (default `.`) is the directory checks run against, relative to the repo root; it does not change where `logDir` resolves (see above). `tddExceptions` is a list of glob patterns excluded from the TDD signal check's changed-source scan. `actFlags` and `sandbox.aptPackages`/`sandbox.pipPackages` are covered in [architecture.md](./architecture.md#act-integration) and [architecture.md#sandbox](./architecture.md#sandbox). `setup` and `commands.*` are covered in "Setup phase" and the check rows above.

## Custom checks

Custom checks let you wire in anything else as a shell command:

```json
{
  "customChecks": [
    { "name": "smoke", "command": "make smoke", "failOnError": false },
    { "name": "schema-diff", "command": "scripts/check-schema.sh", "failOnError": true }
  ]
}
```

`failOnError: false` downgrades a non-zero exit to a `warn` so optional checks still surface without blocking the run.

## Setup phase

Optional bootstrap before checks. Enable with `--setup` or `setup.enabled: true` in `.preflight.json`. When on:

- Node: `npm ci` if `package-lock.json` exists and `node_modules/` is missing
- Node: `npm run build` when `package.json` has a `build` script AND `.github/workflows/ci.yml` shows a `run:` step invoking it before a step invoking the test script. The step has its own wall-clock budget, 300000 ms by default (override with `setup.buildTimeoutMs`): a build that exits non-zero is a blocker naming the exit code and the persisted log, a build that exhausts the budget makes the test check "not evaluated" (a named `skip` plus a limitation) rather than a blocker, and after a successful build any test failure is a genuine blocker. Trust boundary: this is the one place where text in the target repo (a `run:` line in its own workflow file) decides whether that repo's `build` script executes on your machine, so `--setup` belongs only on repositories you already trust to run. See ["Build-required test classification"](#build-required-test-classification-an-unbuilt-package-is-not-a-broken-one) below for the exact detection rule and its documented limits
- Python: creates `.preflight-venv` and installs `requirements.txt` when present
- PHP: `composer install --no-interaction --no-progress` when `vendor/` is missing
- Maven: dependency warmup before the Java compile and test checks
- Gradle: `classes testClasses` before the Java compile and test checks

The setup phase is intentionally conservative. It only runs when the project files make the step unambiguous. For specialized setups, use explicit `commands.*` overrides.

`--setup`'s own `npm ci`/build output does not always fail `clean-worktree`: the runner snapshots `git status --porcelain` before the setup phase runs, and `clean-worktree` judges the check against that snapshot instead of the current state. A change present in the snapshot (predates setup) still fails the check exactly as it always has. Of the paths absent from the snapshot (produced by setup), only UNTRACKED ones are excused: `clean-worktree` stays a `pass`, with the produced paths named in the check's `details` (`--json`/MCP) and in a `limitations` entry (shown by the CLI) recommending `.gitignore`. A TRACKED path setup modified or removed (a committed build artifact the build step rewrote) still fails, naming the paths in the check's `details` (`--json`/MCP) and in a `limitations` entry (shown by the CLI) and recommending they be committed or untracked, with no `.gitignore` suggestion. If the snapshot itself could not be taken (a git error), the check falls back to comparing the full current diff and adds a `limitations` entry saying so. This only excuses the FIRST `--setup` run against un-gitignored output: on a second run, that same output is already present in the pre-setup snapshot (it predates the run), so it reads as pre-existing dirt and fails -- naming the paths and the `.gitignore` remedy when every pre-existing path is untracked, otherwise the plain message. See ["`--setup` can run the build for you"](#--setup-can-run-the-build-for-you) below.

## Behavior notes

- Dependency bootstrap is opt-in. The runner never touches `node_modules/`, `vendor/`, or virtualenvs unless `--setup` is passed.
- Secret detection is git-aware and diff-scoped. A hit is a `fail` blocker only when the secret can reach the remote **and** the current change introduced it: the file is committable (tracked, or untracked-but-not-ignored) **and** the current branch changed it, measured against the merge-base with the upstream / default branch (uncommitted edits and new untracked files included). A hit in a gitignored-and-untracked file (a `.env` holding real credentials is the normal, correct state), in a `.md` documentation file, in a directory that is not a git repository, or in a tracked file the branch never touched is a non-blocking `warn`. When the merge-base cannot be resolved the check fails safe and treats every committable finding as blocking. Set `"secretDetectionStrict": true` to drop the diff-scoping and block on every committable finding. A finding is also downgraded to `warn` (regardless of diff scope or `secretDetectionStrict`) when it is an obvious test-fixture constant: the file lives under a directory literally named `test` or `tests` **and** the matched value itself starts with `test-`/`test_`/`dummy-`/`dummy_`/`fake-`/`fake_`; either condition alone still blocks (see ["Secret detection: obvious test-fixture values don't block"](#secret-detection-obvious-test-fixture-values-dont-block) below for the exact boundary and why it's kept narrow). Keep example values in template files like `.env.example` or `.env.template`. For a measured comparison of the current regex-based engine against gitleaks and trufflehog (class coverage, false positives, runtime, license), see [`docs/secret-scanner-investigation.md`](secret-scanner-investigation.md).
- To suppress an intentional finding (a demo/example key), either list it in `secretAllowlist` in `.preflight.json` (entries are a repo-relative path, a `path:line` pair, or a `*`-glob) or put a `pragma: allowlist secret` comment on the line:

  ```json
  {
    "secretAllowlist": ["demo/playground.ts", "fixtures/*", "src/config.ts:42"],
    "secretDetectionStrict": false
  }
  ```

## Build-required test classification: an unbuilt package is not a broken one

Some Node packages only pass their own tests after a build: a test that
loads its package's `dist/` output fails loudly in a fresh checkout that has
not been built yet, even though the repo's own CI always runs a build step
first. Treating that as a blocking `fail`, the default before this feature,
makes a correct push look broken purely because preflight skipped a build
step the repo's own CI never skips.

The default `npm-test` check (the auto-detected `npm run test`; a
`commands.test` override in `.preflight.json` is not covered) reports that
situation as a distinct, named outcome instead of a blocker: `status:
"skip"` with the missing artifact and the remedy in the message, for example

```
npm test not evaluated: build required before test (a declared build artifact
(packages/needs-build/dist) is missing; the test output reports: Error: Cannot
find module './dist/index.js'); run `npm run build` first (or rerun preflight
with `--setup`, which builds automatically when this repo's CI shows
build-before-test)
```

### What makes a skip legitimate

Three things have to be true at once, and none of them is enough on its own.

1. **The filesystem precondition.** The package that failed has a `build`
   script, and at least one of the artifacts it declares is not on disk.
   Declared artifacts are read from that package's own `package.json` --
   `main`, `module`, `types`/`typings`, `bin` (the string form, or every
   value of the map form), and the string targets of `exports` (subpath keys
   and the `import`/`require`/`default`/`types` conditions; a `*` subpath
   pattern is skipped, since a wildcard cannot be existence-checked) -- plus
   the `outDir` of that package's own `tsconfig.json` when that file parses
   as JSON and declares one. Every path is resolved against the package's own
   directory, and an extensionless declaration (`main: "./dist/index"`) is
   resolved the way Node resolves it, so a package that *is* built is never
   read as unbuilt. A package that declares no entry points at all falls back
   to "`dist/` does not exist"; a package with no build script never meets the
   precondition, whatever is missing.

   The build script has to be the package's **own**. A root fan-out
   (`npm run build --workspaces --if-present`) does not lend one to a workspace
   that has none: `--if-present` skips exactly such a workspace, so the build it
   appears to promise is a no-op there, and a fan-out *without* `--if-present`
   would fail outright on such a workspace, so a repo that runs one has a build
   script in every workspace anyway. A workspace built only by some other
   mechanism (a root `tsc -b` over project references, a Makefile) is therefore
   read as "no build script", and its failure stays a blocker.

   The precondition answers one question: **could running a build change this
   outcome at all?** It is decided by looking at the disk, not by reading the
   test runner's output, because output text alone cannot tell "this package
   was never built" from "this package is broken".

2. **The failing package must not already be built.** This is a property of
   the **package**, not of any one artifact: a package is **partially built**
   when *any* output directory it identifies holds an entry (or cannot be read
   at all). The directories it identifies are the directory of each artifact
   it declares -- `dist/index.js` identifies `dist/`, a bare `dist` or a
   tsconfig `outDir` identifies itself, an artifact at the package root
   (`main: "index.js"`) identifies none, since a whole package is not build
   output -- plus the conventional `dist/` when it identifies none of its own.
   A directory that canonicalizes outside the package (a `dist` symlinked
   elsewhere) is not this package's output and is not read.

   A partially built package **never** downgrades: not for a stack frame in
   its live `dist/`, not for an absent sibling in there, not for the declared
   artifact itself. A package can declare an artifact its build never emits --
   a `types: "dist/index.d.ts"` next to a JavaScript-only build, an `exports`
   subpath that was dropped, a `bin` that moved -- so condition 1 holds
   permanently while the real output is on disk and is exactly what the tests
   load. Without this rule that package's own failures corroborated as "not
   built yet", the repo was reported `ready: true`, and it stayed that way
   after a successful `npm run build`, because that build does not produce the
   missing artifact either.

   A declaration that names an output a build legitimately never fills at all
   (an optional CSS export, a `types` directory a JavaScript-only build never
   writes) is the same cost from the other side: the precondition holds
   forever, whatever else the package does hold. No per-declaration opt-out
   is offered for it in `.preflight.json`; it stays a documented cost, closed
   by fixing the declaration. This is a judgment: every instance of the
   shape in this package's fixtures and hand-built reproduction cases was
   constructed to exercise this rule (`single-package-second-output-dir`
   and its reproduction siblings), no organically occurring instance is
   known, and one hand-built family does not by itself justify a
   `.preflight.json` surface for the rest.

   Reading the **directories**, and all of them, is what makes this a package
   property. A declared artifact on disk necessarily makes its own directory
   non-empty, so "any declared artifact is on disk" is included. Reading only
   the *missing* artifact's directory is not enough, and both counter-shapes
   are ordinary: a package whose `main: dist/index.js` is built while its
   `types: dist/types/index.d.ts` is never emitted has a populated `dist/` and
   an absent `dist/types/`, and one whose `exports` name `./dist/index.js` and
   `./lib/styles.css` has a populated `dist/` and an absent `lib/`. Both are
   built; reading one directory reported both as unbuilt.

   **The deliberate consequences.** The rule counts entries rather than
   judging which of them are "real" build output, so it reads the same way in
   every repository, and *any* entry counts:

   - a **stale** output directory (an older build missing a newly added entry)
     blocks instead of skipping;
   - so does a placeholder or a checked-in file in there (a `.gitkeep`, a
     `.keep` that lets git carry an otherwise empty output directory), and so
     does an OS or tool artefact that happens to sit in it (a `.DS_Store`, an
     editor or bundler cache directory);
   - so does a directory the package declares an artifact in that is not
     build output at all (a checked-in `bin/` launcher beside a `dist/` the
     build writes, an `exports` target inside a source directory): the rule
     cannot tell source from output, so such a package blocks even when
     nothing was ever built, and what fixes it is the declaration, not a
     build. A declared directory under `node_modules` is the one exception
     and is never read: installed dependencies say nothing about whether the
     package was built, which is the rule condition 3 applies to paths too;
   - the directory state is read **after** the test run, when the failure is
     classified, and nothing is snapshotted beforehand: a test that itself
     writes into its package's output directory (a cache, a fixture, a
     generated file) therefore makes that package read as partially built;
   - the read goes through the filesystem, so on a case-insensitive filesystem
     (macOS and Windows by default) a declaration spelled `Dist/index.js`
     reads the real `dist/` directory. That is the opposite of the
     case-sensitive **path** comparison in condition 3, and deliberately so:
     one asks the OS what is on disk, the other compares two strings.

   A narrower reading of the third bullet above was tried and rejected:
   exclude a directory from the read whenever it holds a git-tracked file, so
   a checked-in `bin/` launcher stops blocking a package whose real `dist/`
   is genuinely built. Rejected on the argument that actually holds: a
   tracked-file test cannot distinguish a checked-in source directory from a
   checked-in build-output directory (a committed `dist/`, a committed
   symlink standing in for one, a committed `.keep` placeholder), so a
   repository that commits its output would turn its blocking `fail` into
   the named `skip`, the exact false-green class this rule exists to
   prevent. The flip evidence behind an earlier draft of this rejection and
   the preparation bias that invalidated it are recorded in the CHANGELOG
   entry for this rule; this section carries the decision only. The
   oclif-style `bin/`
   false-block this rejection describes stays an open cost, no opt-out was
   added for it. A later measurement rejected the narrower rule (tracked,
   AND not `.gitignore`d, AND another declared output directory of the same
   package is populated): it leaves the motivating unbuilt cases blocked,
   while two committed output directories can exempt each other and turn a
   real failure into a build-required skip. The portable corpus, normalized
   verdicts, and raw replay instructions are in
   [`experiments/partial-build-exemption`](../experiments/partial-build-exemption/).

   The remedy is the build, or, where a declaration names a directory that
   is not build output, the declaration; either way blocking is the safe
   direction for a tool whose `ready: true` opens push gates. When such a
   package's failure does name a path in its own output, the message says so,
   naming the directory that decided it, the artifact that is missing, and the
   remedy:

   ```
   npm test failed: the build output directory (dist) of this repo exists and
   is not empty, but a declared build artifact (dist/cli.js) is not on disk:
   the build output on disk does not contain it, so the failure is reported as
   a real failure; rerun the build and preflight if this output is stale
   ```

   An output path that exists but cannot be read as a directory at all (a
   `dist` that is a *file*, a permission error) leaves the state unproven,
   which counts as built for the verdict, the safe direction, and is
   reported as what it is (`could not be read (ENOTDIR)`), never as entries
   nobody counted.

3. **The failure has to blame the missing artifact**, and that is decided as
   a **path** rule, never as a text match. Every path-shaped token on every
   line of the failing package's own output is resolved and then tested:

   - a token is an absolute path, a `file://` URL, or a `./` / `../`
     specifier. A bare specifier is not one, neither `lodash` nor
     `dist/index.js`, because Node resolves both through `node_modules`, so
     they name a dependency rather than this package's build output;
   - a token past a hard bound (4096 characters, or 256 path segments) is not
     resolved at all. Test output is untrusted input and every resolved path
     is then walked segment by segment, so an unbounded token in a failing
     test's output could abort the whole run instead of reporting that
     failure. Both bounds sit far above any real path; a token past them
     simply does not corroborate, which leaves the check a blocking `fail`;
   - relative tokens are resolved against the failing package's own directory,
     absolute ones as printed. Symlinks are then resolved on **both** sides,
     through the longest part of each path that exists, so a checkout under a
     symlinked path matches, and so does a package whose declared `dist` is a
     symlink to the directory its build really writes;
   - comparison is **case-sensitive**, whatever the filesystem underneath
     does. On a case-insensitive filesystem (macOS and Windows by default) a
     token spelled `./Dist/index.js` against a declared `dist/index.js` names
     the same file to the OS and still does not corroborate. That is the safe
     direction (the check stays a blocking `fail`), and no case-folding is
     applied to keep the rule identical on every platform;
   - the resolved path is accepted when it **is** the missing artifact, or
     when it **is, or lies inside, that build-output directory** *and is
     itself not present on disk* (`dist/index.js` accepts anything absent
     under that `dist/`, including a report naming `./dist/` itself; a bare
     `dist` or a tsconfig `outDir` accepts anything absent under it; an
     artifact declared at the package root, `main: "index.js"`, identifies no
     build-output directory at all and accepts only itself), **and** it is
     inside the repository, **and** it has no `node_modules` segment,
     **and** it belongs to this package rather than a neighbouring or nested
     one.

   Whether the package is already built is **not** part of this rule: that is
   condition 2, and the two are kept apart so a blocking message can say which
   of them refused the downgrade. A partially built package whose failure
   names nothing in its own output is reported with the plain sentence (*a
   declared build artifact (X) is missing, but the failure does not name it*)
   rather than with an explanation of an output directory the failure never
   mentioned.

   That covers both shapes this actually takes: a package's own guard
   printing `<abs>/dist/index.js is missing. Run the build first` with no error
   prefix at all, and Node's own `Cannot find module './dist/index.js'` /
   `ENOENT ... open '<path>'`, whose quoted specifier is simply another token
   on the line.

   This third condition is what keeps the first one honest. Plenty of
   packages compile to `dist/` but run their tests from source (this repo is
   one), so in a fresh checkout the precondition holds for them permanently.
   Without requiring the failure to actually be about the missing artifact, a
   genuinely broken suite in such a package would be reported as `ready:
   true`. An earlier substring form of this rule did exactly that for a stale
   relative require, a dependency missing under `node_modules/<lib>/dist/`,
   another workspace's artifact, and any test-runner stack frame through
   `node_modules/vitest/dist/`.

   Two consequences worth knowing:

   - A relative specifier is resolved against the package directory, not
     against the file that raised it (the output does not say which file that
     was). A test in a nested directory requiring `../dist/index.js` therefore
     resolves outside the package and does **not** corroborate: the check
     stays a blocking `fail`, which is the safe direction.
   - **The residual case this cannot decide**: a package with **no output on
     disk at all**, every output directory it identifies absent or empty,
     failing on a path inside one of them that a build would not create
     either, such as a stale reference to a `dist/old.js`. That is
     indistinguishable from "not built yet", because nothing on disk separates
     the two until a build has actually run, and it is reported as the named
     skip. The remedy that skip names (run the build, or rerun with `--setup`)
     resolves it either way: after the build the output directory holds
     entries, so the same failure comes back as a blocker. Two shapes that
     look similar are *not* this case: a failure naming a path that *is* on
     disk never corroborated, and a package holding output in *any* of its
     directories is a partially built package, which blocks.

An npm-workspaces monorepo's `npm test` fan-out is judged **per workspace**,
not as one blob: the combined output is split at each workspace's own `>
<name>@<version> <script>` preamble (the root package's own preamble is
recognized by identity and excluded, npm prints the same shape for it when
the root `package.json` carries a `version`), each workspace npm reported as
failed is resolved to its directory by package name, and both conditions
above must hold for **every** one of them. One workspace missing its build
next to a different, genuinely broken workspace stays a blocking `fail`. A
failure that cannot be attributed to a workspace at all (a single-package
repo, a non-npm runner) is judged against the root package.

### The negative controls

Each of these stays a blocking `fail`, and each has a fixture in
`tests/fixtures/` that pins it:

- a genuine test failure in a repo with no build script anywhere (the
  message then names the missing-module observation and says no `build`
  script was found, so the remedy is not a dead end);
- a genuine failure in a package whose declared artifacts are all present,
  including a module error for some other file inside an already-built
  `dist/` (a missing file inside a built `dist/` is a different bug);
- a genuine failure in an unbuilt package when nothing in the failure names
  the missing artifact;
- a monorepo where one workspace is unbuilt and another is genuinely broken,
  in either order;
- an unbuilt package whose failure is a stale relative require into its own
  source tree, alone and next to an unbuilt workspace in a monorepo (both
  packages then meet the precondition, so only the path rule separates them);
- a missing dependency reported by a `node_modules` path whose tail is
  byte-for-byte the declared artifact (`.../node_modules/some-lib/dist/index.js`);
- a package that declares no entry points, failing an ordinary assertion whose
  only `dist`-bearing line is the test runner's own stack frame inside
  `node_modules`;
- a workspace whose failure names a *neighbouring* workspace's artifact;
- a workspace with no build script of its own under a root
  `--workspaces --if-present` fan-out (nothing would build it, so the remedy
  would be a dead end);
- a package whose `tsconfig.json` has comments (so its `outDir` cannot be read
  and the fallback `dist/` applies) failing on a path in a different directory;
- seven **partially built** packages, each declaring an artifact its build
  never emits: a `types` next to a JavaScript-only build, a dropped `exports`
  subpath, a `bin` that is never emitted while the test loads exactly it, a
  stale `types` next to a template the build never copies, that last shape
  again as a workspace under a root `--workspaces --if-present` fan-out, a
  `types` in a **nested** directory (`dist/types/`) beside a populated
  `dist/`, and an `exports` target in a **second** output directory (`lib/`)
  beside a populated `dist/`. Their preconditions hold forever, so only the
  package-level rule separates them from a missing build, and the last two are
  exactly the shapes a per-artifact reading of it got wrong. Each fixture is
  asserted in **both** states, and they differ: unbuilt (no output directory
  at all) each one is the named skip, and after a successful build each one is
  a blocking `fail`, including after a second build, which cannot create the
  artifact either. Which sentence that blocker carries depends on the failure:
  the five whose failure names an absent path in the package's own output are
  reported with the directory, the artifact and the remedy; the two whose
  failure is a genuine bug inside the live `dist/` (so the only path they name
  *is* on disk) keep the plain "the failure does not name it" sentence;
- a package whose declared `dist/` holds a single placeholder file: any entry
  makes it partially built, so it blocks (the same fixture with an **empty**
  `dist/` is the named skip);
- a failing test whose output prints a pathological path-shaped token (30000
  segments on one line): the classification no longer aborts the run, and the
  test failure is the blocker;
- any failure after `--setup`'s own build step ran, whether it failed or
  succeeded (see below).

Two positive controls have fixtures of their own as well: a package whose
declared `dist` is a **symlink** to the directory its build really writes
(both sides canonicalize to the same file, so a plainly unbuilt package is not
reported as broken), and the same package after a build, which passes. The
symlink fixture pins the cost of the package-level rule from the other side
too: with the `.keep` placeholder that lets git carry its empty output
directory left in place, the same unbuilt package reads as partially built and
blocks.

The artifact named in these messages is always spelled relative to the
repository path **as you passed it**; canonicalization stays inside the
matching. A workspace whose directory is reached through a symlink is named by
its physical directory, since that is the only directory the package index
sees, and the remedy in the same message names the workspace by the name npm
printed.

### `--setup` can run the build for you

Alongside the named outcome, `--setup` runs the repo's own build before the
test check, but only when both hold: `package.json` has a `build` script,
AND `.github/workflows/ci.yml` shows a `run:` step invoking `npm run build`
(or the `yarn`/`pnpm` equivalent) before a step invoking the test script, by
raw line order in that one file. This is a deliberately conservative,
best-effort read, not a GitHub Actions execution-graph evaluator:

- Only `.github/workflows/ci.yml` by that exact name is read; other workflow
  files, reusable workflows, and composite actions are not consulted.
- Only single-line `run: <command>` steps are recognized; a YAML block scalar
  (`run: |` followed by more lines) is not parsed for its body. A `run:` step
  whose value is itself a shell comment (`run: # npm run build`) or that only
  echoes a string (`run: echo 'npm run build is documented'`) is recognized
  and skipped, since neither actually invokes the build.
- Ordering is by line number, not GitHub Actions' actual job/`needs:`
  execution graph: a multi-job workflow whose real build-before-test order
  comes from job dependencies is not modeled, including a build step that
  sits in a job unrelated to the one that runs tests.

These gaps do not all fail the same direction. A false **miss** (a real
build-before-test convention this reader cannot see) only costs the extra
manual `npm run build` this feature exists to avoid; `--setup` then behaves
exactly as it did before this feature (dependency install only), and the
test check falls back to the named skip. A false **hit** (an unrelated job's
build step read as "before" the test job by line order alone) only costs a
redundant rebuild under `--setup`. Neither direction causes `--setup` to skip
a build the repo's real CI relies on.

**Trust.** Under `--setup`, a `run:` line in the target repo's own
`.github/workflows/ci.yml` is what decides whether that repo's `build` script
executes on your machine. Workflow text is repository content, so `--setup`
belongs only on repositories you already trust to run, the same trust
`customChecks[].command` and the `commands.*` overrides already require. Without `--setup`, no build script is
ever executed.

The build step gets its own wall-clock budget, **300000 ms** by default (the
same budget the test check gets, rather than the 120000 ms the dependency
installs share). Override it with `setup.buildTimeoutMs` in
`.preflight.json`: a positive integer, in milliseconds, up to one day
(86400000 ms); any other value (non-finite, non-integer, non-positive, or
above that bound) is dropped with a warning and the default applies. The
three outcomes are deliberately different:

- **Non-zero exit**: the repo genuinely does not build right now, so the test
  check's subsequent failure is a real break. It stays a blocking `fail`, and
  the message names the exit code and the persisted build log.
- **Timeout**: the build did not answer, so nothing was learned about the
  repo. The test check stays "not evaluated" (the named `skip`, with the
  timeout named in the message and a `limitations` entry), which is the same
  direction every other did-not-answer path in this tool takes (see the
  `npm-audit` skip). A timeout is never a blocker.
- **Success**: the build ran to completion, so whatever the tests report now
  is genuine, and the check stays a blocking `fail`. Normally the precondition
  already says so, because the artifacts now exist; the explicit rule also
  covers a build script that exits 0 without producing them, where "run the
  build first" would be a dead end.

The remedy named in a skip message depends on what could actually fix it.
`--setup` only ever runs `npm run build` at the repo root, so the message
names that when the failing unit *is* the root package, or when the root build
script fans out over the workspaces (`--workspaces`/`-ws`) and therefore
reaches them. Otherwise it names a workspace-scoped `npm run build -w <name>`
(or `--workspaces --if-present` for more than one failing workspace, each of
which has its own build script by then) and says why `--setup` cannot help.

Confidence score: a build-required skip is scored exactly like any other
`skip` outcome (see [confidence-scoring.md](./confidence-scoring.md)).
Its weight (0.2 for the test check) counts toward the confidence denominator
but not the numerator, and the accompanying `limitations` entry adds the usual
0.03 penalty (capped at 0.2 total across all limitations). It is not scored as
a `pass`, and it is not scored more harshly than an `npm-audit` skip for the
same reason (no report to judge).

## Waiving a permanently-failing check: `checks.<kind>.acknowledge`

Some check failures are not a signal to fix before pushing: they are a
known, permanent gap (a platform-specific test suite that only runs on the
CI runner's OS, for example). For those, give the check's toggle in
`.preflight.json` an `acknowledge` reason instead of `true`/`false`:

```json
{
  "checks": {
    "test": { "acknowledge": "install-sh suite is linux-only, CI covers it" }
  }
}
```

The check still runs. If it fails, that failure is downgraded from `fail`
to a new `acknowledged` status instead of being dropped or hidden:

- `ready` becomes `true` (an acknowledged check is not a blocker), but the
  check keeps its own `acknowledged` status in `checks[]`: a caller reading
  only `ready`/`blockers` still sees `ready: true`, but anything reading
  `checks[]` sees the check did not actually pass.
- An acknowledged check never appears in `blockers[]` (only `fail` does) or
  `warnings[]` (only `warn` does): it is visible *exclusively* through its
  own `status: "acknowledged"` entry in `checks[]`. A consumer that only
  quotes `blockers`/`warnings` and never scans `checks[]` will report a
  clean "READY" without ever surfacing that a failure was waived.
- The check's `message` is rewritten to include the reason
  (`"... (acknowledged: install-sh suite is linux-only, CI covers it)"`),
  and a matching entry is added to `limitations`, so the waiver is visible
  in `--json` output.
- The human-output CLI prints a dedicated `Acknowledged (failed, but
  waived, not counted as a blocker):` section naming the check and reason.
  `preflight batch`'s one-line-per-repo summary has no room for that
  section, so it instead appends a compact `[n acknowledged]` marker to a
  repo's line when that repo has one or more acknowledged checks.

It is never silent about a REJECTED acknowledge: `acknowledge` requires a
non-empty string, and a present-but-unusable value (`{ "acknowledge": "" }`,
`{ "acknowledge": 12345 }`, etc.) is rejected: the check is left exactly as
it would be without an acknowledge (still a blocker if it failed), and the
rejection is reported once per check kind as a `limitations` entry, so a
typo'd config can never silently waive a real failure. A bare `{}` (no
`acknowledge` key at all) is a *different* case: it carries nothing to
reject, so it is not reported anywhere: the check simply runs enabled,
identical to `true`, with no acknowledge behavior in play.

**Deliberate boundaries:**
- Scoped to checks that failed (`fail`); a `pass`/`warn`/`skip` result is
  already non-blocking and is left untouched.
- Applies to the `checks.*` boolean toggles (`gitState`, `lint`,
  `typecheck`, `test`, `audit`, `commitConvention`, `tdd`): one reason
  acknowledges every check of that kind for the whole run (e.g. every
  `commands.test` entry), not a single named sub-check.
- **Not supported** for `ciSimulation` (its toggle stays a plain boolean,
  acknowledging CI-simulation behavior is out of scope for this feature) or
  for `customChecks` (which already have their own per-check
  `failOnError: false` waiver instead).
- **Not supported** for `secretDetection` either (its toggle also stays a
  plain boolean, a deliberate design choice): every other kind above waives
  the whole check for the run, but a secret-detection finding is not
  interchangeable that way: one `acknowledge` reason would blind every
  *future* secret in the repo, not just the finding an operator actually
  reviewed. Use `secretAllowlist` (a `path` or `path:line` entry) or an
  inline `pragma: allowlist secret` comment instead, both scoped to one
  specific, already-reviewed finding, see "Secret detection: obvious
  test-fixture values don't block" below. A configured but ignored
  `checks.secretDetection.acknowledge` is reported in `limitations` (not
  silently dropped), pointing at these alternatives.

## Secret detection: obvious test-fixture values don't block

A secret-shaped match (`TOKEN = "..."`, `apiKey = "..."`, etc.) is
downgraded from `fail` to a non-blocking `warn` when **both** of these
hold, regardless of diff scope or `secretDetectionStrict`:

- the file lives under a directory literally named `test` or `tests`
  (e.g. `tests/test_notify_planforge.py`), and
- the matched value itself, immediately after the `:`/`=` and an optional
  quote, starts with `test-`, `test_`, `dummy-`, `dummy_`, `fake-`, or
  `fake_` (e.g. `"test-planforge-bot-token"`).

A line carrying an unambiguous credential shape, a `ghp_...` token, a PEM
private-key header, or an AWS access key ID (the `AKIA`/`ASIA`/`ABIA`/
`ACCA`/`A3T...` prefix family), always blocks regardless of either
condition above; the escape hatch there is `secretAllowlist` or the
inline `pragma: allowlist secret` comment, not this heuristic.

This is deliberately narrow on both axes so it cannot mask a real secret:
a realistic-looking value outside any `test`/`tests` directory still
blocks, and a realistic-looking value *inside* `tests/` that doesn't carry
one of those prefixes still blocks too: being under a test directory
alone is not sufficient. It does not cover other test-directory
conventions (`__tests__`, `spec`, `e2e`, ...) or a fixture-looking prefix
that isn't the assigned value itself; widen `secretAllowlist` or an inline
`pragma: allowlist secret` comment (see above) for those instead.
