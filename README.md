# agent-preflight

Validate your repo locally before pushing, with a confidence score an agent can read.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge), generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit), guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)

agent-preflight runs lint, typecheck, test, dependency audit, secret detection, commit-convention, and (optionally) an `act`-based CI dry-run that validates your GitHub Actions workflow plan against your working tree, then returns a structured result with a confidence score between 0 and 1. It exists to break the "change, push, wait for CI, fix, repeat" loop that AI agents run into when they cannot tell whether the pipeline will accept their work. Local validation, JSON output, deterministic scoring.

## Try it in 60 seconds

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
./install.sh
source ~/.bashrc

# run against any local repo (or the current directory)
preflight run .
```

Or install via npm:

```bash
npm install -g @lannguyensi/agent-preflight
preflight run .
```

The published package is scoped (`@lannguyensi/agent-preflight`) but the binary is still `preflight` (npm's typo-squat protection blocks the unscoped name).

## What a run looks like

```
preflight: READY (confidence: 89%)

Warnings:
  4 recent commit(s) don't follow conventional format

Limitations (not validated locally):
  secret detection uses pattern matching; not exhaustive
  CI simulation skipped (enable with checks.ciSimulation: true, requires act)

Checks: 9 | Duration: 20544ms
```

Or as JSON for an agent:

```json
{
  "ready": true,
  "confidence": 0.89,
  "blockers": [],
  "warnings": ["4 recent commit(s) don't follow conventional format"],
  "limitations": [
    "secret detection uses pattern matching; not exhaustive",
    "CI simulation skipped (enable with checks.ciSimulation: true, requires act)"
  ],
  "durationMs": 20544,
  "timestamp": "2026-04-28T07:00:00.000Z"
}
```

`ready: true` means no blocking failures. The score is a weighted ratio of passed checks with a small penalty per limitation, so an agent can read both signals and decide whether to push.

## Next steps

| If you want to... | Read |
|------|------|
| Know what each check verifies and how to toggle it | [docs/checks.md](docs/checks.md) |
| Understand the score, weights, and thresholds | [docs/confidence-scoring.md](docs/confidence-scoring.md) |
| See how the runner, act integration, and sandbox fit together | [docs/architecture.md](docs/architecture.md) |
| Wire it into agent-tasks as a claim gate | [docs/integration.md](docs/integration.md) |
| Use it from a Claude Code / opencode hook layer | [`harness`](https://github.com/LanNguyenSi/harness), the canonical hook-wiring layer that fires `preflight run` deterministically on `SessionStart` / `PreToolUse` and gates further work on its ledger output ([architecture §5](https://github.com/LanNguyenSi/harness/blob/master/docs/ARCHITECTURE.md), [Appendix A](https://github.com/LanNguyenSi/harness/blob/master/docs/ARCHITECTURE.md)) |

## Common commands

```bash
preflight run                              # current dir
preflight run ./my-project                 # explicit path
preflight run ./my-project --json          # machine-readable
preflight run --ci-simulation              # add act --dryrun CI plan validation
preflight run --setup                      # bootstrap deps before checks

preflight batch ~/git                      # every repo under a root
preflight batch ~/git --only "frost-*"
preflight batch ~/git --exclude "*-playground"

preflight sandbox                          # run inside a docker image
preflight sandbox --print                  # show the docker command
preflight sandbox --docker-socket --ci-simulation
```

`preflight batch` is inspired by [`git-batch-cli`](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/git-batch-cli) and runs the single-repo path against every git repo under the given root.

## MCP server

`preflight-mcp` exposes the same runner over [MCP](https://modelcontextprotocol.io) (stdio only) so other agents/tools can call preflight in-process instead of shelling out to the CLI. Register it once and it survives a session restart:

```bash
claude mcp add preflight -- preflight-mcp
```

or, without a global install:

```bash
claude mcp add preflight -- node /path/to/agent-preflight/dist/mcp.js
```

Two tools:

| Tool | Input | Returns |
|------|-------|---------|
| `preflight_run` | `{ repoPath, ciSimulation?, noAudit?, noSecrets? }` | Exactly what `preflight run --json` prints: `ready`, `confidence`, `checks`, `blockers`, `warnings`, `limitations`, `durationMs`, `timestamp` |
| `preflight_batch` | `{ root, only?, exclude?, noAudit?, noSecrets? }` | Exactly what `preflight batch --json` prints: per-repo results plus aggregate `ready`/`notReady`/`skipped` counts |

Both tool descriptions carry the same semantics as the CLI's exit code: **`ready: false` (or a per-repo `result.ready: false`) means that repo/PR will likely break CI — do not merge on it.** `ciSimulation`, `noAudit`, and `noSecrets` mirror the CLI's `--ci-simulation`, `--no-audit`, and `--no-secrets` flags (`preflight_batch`'s `noAudit`/`noSecrets` apply to every repo in the batch, same as the CLI's `--no-audit`/`--no-secrets`). A `repoPath`/`root` that doesn't exist, or exists but isn't a directory, returns a structured tool error (`isError: true`), not a crash.

This is stdio-only — no remote/HTTP transport, no new checks beyond what `preflight run`/`preflight batch` already do.

**Security: the target repo is not just data.** Its `.preflight.json` can define shell commands (`customChecks[].command`, `commands.lint`/`typecheck`/`test`/`audit`) that these tools execute on the machine running the MCP server. Only point `preflight_run`/`preflight_batch` at repositories you trust — this is the same execution surface `preflight run`/`preflight batch` already have on the CLI, just now reachable by whatever agent/tool is calling the MCP server. With `--setup` (or `setup.enabled`), a `run:` line in the target repo's own `.github/workflows/ci.yml` additionally decides whether that repo's `build` script is executed on your machine, so `--setup` belongs only on repositories you already trust to run; see ["Build-required test classification"](#build-required-test-classification-an-unbuilt-package-is-not-a-broken-one) for the exact rule.

**Timeouts and long runs.** The MCP SDK's default request timeout is 60s; a real `preflight_run` (let alone `preflight_batch`, which loops over every repo under `root`) can easily take longer. Both tools send a `notifications/progress` ping roughly every 10s while the underlying checks are still running, but only when your client attaches a `progressToken` to the request — passing an `onprogress` callback (e.g. `client.callTool(..., { onprogress })` in the TypeScript SDK) does that automatically. That switch alone only gets you the pings, though: it does not by itself extend the 60s timeout. To actually survive past 60s, also pass `resetTimeoutOnProgress: true` in the same call's request options, so the client resets its timeout on every ping it receives — or just raise the request's own `timeout` outright. `preflight_batch` in particular is expected to be long-running, so plan for one of those two switches.

## Configuration

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

The TDD counterpart check associates filenames only; it does not establish
coverage or prove a TDD workflow. For a direct nested target or `workingDir`,
changed sources and test counterparts are both evaluated relative to that
directory. Sources in sibling packages (including similarly prefixed paths)
are outside that target.

If no commands are configured, agent-preflight auto-detects common Node, Python, PHP, and Java manifests and picks reasonable defaults. The full toggle, override, and monorepo guidance lives in [docs/checks.md](docs/checks.md). Sandbox image profiles, apt packages, and act flags are covered in [docs/architecture.md](docs/architecture.md#sandbox). The `npm-audit` check runs with a bounded timeout, and an audit that did not answer is reported as `skip` (not `warn`) with a `limitations` entry naming the cause: a timeout with no parsable report, or npm exiting non-zero without producing a report, which is what an unreachable or failing registry produces. That is the default direction rather than a list of recognized registry errors, so an outage never hangs the run, and an unfamiliar failure degrades to "not evaluated" instead of being misread as a real finding. npm's own usage errors, such as a missing lockfile, name themselves in `error.code` and stay a `warn` naming that failure.

### Build-required test classification: an unbuilt package is not a broken one

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

#### What makes a skip legitimate

Two things have to be true at once, and neither is enough on its own.

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

2. **The failure has to blame the missing artifact**, and that is decided as
   a **path** rule, never as a text match. Every path-shaped token on every
   line of the failing package's own output is resolved and then tested:

   - a token is an absolute path, a `file://` URL, or a `./` / `../`
     specifier. A bare specifier is not one -- neither `lodash` nor
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
   - nothing corroborates at all unless the **build-output directory** the
     missing artifact identifies (the directory of `dist/index.js`; a bare
     `dist` or a tsconfig `outDir` itself) is **absent, or empty**. Any entry
     in it -- one file, a placeholder, anything -- means a build ran, so the
     package is partially built rather than unbuilt (see below);
   - the resolved path is accepted when it **is** the missing artifact, or
     when it **is, or lies inside, that build-output directory** *and is
     itself not present on disk* (`dist/index.js` accepts anything absent
     under that `dist/`, including a report naming `./dist/` itself; a bare
     `dist` or a tsconfig `outDir` accepts anything absent under it; an
     artifact declared at the package root, `main: "index.js"`, identifies no
     build-output directory at all, so it is not subject to the rule above and
     accepts only itself), **and** it is inside the repository, **and** it has
     no `node_modules` segment, **and** it belongs to this package rather than
     a neighbouring or nested one.

   The **absent-or-empty** rule is what keeps a **partially built** package
   honest. A package can declare an artifact its build never emits -- a
   `types: "dist/index.d.ts"` next to a JavaScript-only build, an `exports`
   subpath that was dropped, a `bin` that moved -- so the precondition above
   holds permanently while the real `dist/` is on disk and is exactly what the
   tests load. Without it, that package's own failures corroborated as "not
   built yet": a genuine runtime failure's stack frame in the built output
   (`<pkg>/dist/index.js:1`), an `ENOENT` on a template the build never copies,
   a `Cannot find module` for the never-emitted `bin` itself. The repo was
   reported `ready: true`, and stayed that way after a successful
   `npm run build`, because that build does not produce the missing artifact
   either. An output directory holding *anything* is evidence that a build ran
   and did not produce the artifact, which no further build fixes.

   **The deliberate consequence:** a *stale* partial output directory -- an
   older build missing a newly added entry, a `dist/` carrying a checked-in
   file or a `.keep` placeholder -- now **blocks** instead of skipping, and the
   message names both the directory and the artifact:

   ```
   npm test failed: the build output directory (dist) of this repo exists and
   is not empty, but a declared build artifact (dist/cli.js) is missing from
   it, so a build ran and did not produce that artifact; the failure is
   reported as a real failure
   ```

   The remedy is the same build, and blocking is the safe direction for a tool
   whose `ready: true` opens push gates. The rule counts entries rather than
   judging which of them are "real" build output, so it reads the same way in
   every repository.

   That covers both shapes this actually takes -- a package's own guard
   printing `<abs>/dist/index.js is missing. Run the build first` with no error
   prefix at all, and Node's own `Cannot find module './dist/index.js'` /
   `ENOENT ... open '<path>'`, whose quoted specifier is simply another token
   on the line.

   This second condition is what keeps the first one honest. Plenty of
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
   - **The residual case this cannot decide**: a package whose build-output
     directory is **absent or empty**, failing on a path inside that
     directory that a build would not create either -- a stale reference to a
     `dist/old.js`. That is indistinguishable from "not built yet", because
     nothing on disk separates the two until a build has actually run, and it
     is reported as the named skip. The remedy that skip names (run the build,
     or rerun with `--setup`) resolves it either way: after the build the
     output directory holds entries, so the same failure comes back as a
     blocker. Two shapes that look similar are *not* this case: a failure
     naming a path that *is* on disk never corroborated, and a package whose
     output directory already holds something is a partially built package,
     which blocks.

An npm-workspaces monorepo's `npm test` fan-out is judged **per workspace**,
not as one blob: the combined output is split at each workspace's own `>
<name>@<version> <script>` preamble (the root package's own preamble is
recognized by identity and excluded -- npm prints the same shape for it when
the root `package.json` carries a `version`), each workspace npm reported as
failed is resolved to its directory by package name, and both conditions
above must hold for **every** one of them. One workspace missing its build
next to a different, genuinely broken workspace stays a blocking `fail`. A
failure that cannot be attributed to a workspace at all (a single-package
repo, a non-npm runner) is judged against the root package.

#### The negative controls

Each of these stays a blocking `fail`, and each has a fixture in
`tests/fixtures/` that pins it:

- a genuine test failure in a repo with no build script anywhere (the
  message then names the missing-module observation and says no `build`
  script was found, so the remedy is not a dead end);
- a genuine failure in a package whose declared artifacts are all present,
  including a module error for some other file inside an already-built
  `dist/` -- a missing file inside a built `dist/` is a different bug;
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
- five **partially built** packages, each declaring an artifact its build never
  emits -- a `types` next to a JavaScript-only build, a dropped `exports`
  subpath, a `bin` that is never emitted while the test loads exactly it, a
  stale `types` next to a template the build never copies, and that last shape
  again as a workspace under a root `--workspaces --if-present` fan-out. Their
  preconditions hold forever, so only the absent-or-empty rule separates them
  from a missing build. Each fixture is asserted in **both** states, and they
  differ: unbuilt (no `dist/` at all) each one is the named skip, and after a
  successful build each one is a blocking `fail` naming the output directory
  and the artifact -- including after a second build, which cannot create the
  artifact either;
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
symlink fixture pins the cost of the absent-or-empty rule from the other side
too: with the `.keep` placeholder that lets git carry its empty output
directory left in place, the same unbuilt package reads as partially built and
blocks.

The artifact named in these messages is always spelled relative to the
repository path **as you passed it**; canonicalization stays inside the
matching. A workspace whose directory is reached through a symlink is named by
its physical directory, since that is the only directory the package index
sees, and the remedy in the same message names the workspace by the name npm
printed.

#### `--setup` can run the build for you

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
belongs only on repositories you already trust to run -- the same trust
`customChecks[].command` and the `commands.*` overrides already require (see
the Security note under "MCP server"). Without `--setup`, no build script is
ever executed.

The build step gets its own wall-clock budget, **300000 ms** by default (the
same budget the test check gets, rather than the 120000 ms the dependency
installs share). Override it with `setup.buildTimeoutMs` in
`.preflight.json`. The three outcomes are deliberately different:

- **Non-zero exit**: the repo genuinely does not build right now, so the test
  check's subsequent failure is a real break. It stays a blocking `fail`, and
  the message names the exit code and the persisted build log.
- **Timeout**: the build did not answer, so nothing was learned about the
  repo. The test check stays "not evaluated" -- the named `skip`, with the
  timeout named in the message and a `limitations` entry -- which is the same
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
`skip` outcome (see [docs/confidence-scoring.md](docs/confidence-scoring.md)).
Its weight (0.2 for the test check) counts toward the confidence denominator
but not the numerator, and the accompanying `limitations` entry adds the usual
0.03 penalty (capped at 0.2 total across all limitations). It is not scored as
a `pass`, and it is not scored more harshly than an `npm-audit` skip for the
same reason (no report to judge).

When a shell-based check (lint, typecheck, test, audit, custom) fails, its
complete stdout+stderr is written best-effort to
`~/.agent-preflight/logs/<check>-<epoch-ms>-<pid>-<sequence>.log` — override
the directory with `logDir` in `.preflight.json` (a relative path resolves
against the repo root, not `workingDir` and not the process's cwd; a
leading `~/` is expanded to the home directory). If `logDir` points inside
the repo itself, as the `.preflight-logs` example above does, add that
directory to `.gitignore` — otherwise the log files it fills up show up as
untracked changes, and the *next* run's own `clean-worktree` check fails on
them. The pid and per-process sequence number together keep two failures of
the same check from colliding even at the identical millisecond, whether
they come from the same process or two concurrent `preflight` runs sharing
a log directory. Only the 20 newest files matching this feature's own
naming scheme (`<check>-<epoch-ms>[-<pid>]-<sequence>.log`; the pid segment
is optional so log files written before it existed are still recognized and
drained instead of accumulating forever) are kept — any other file dropped
into that directory by another tool is left untouched. The check's
`details` lead with `full output: <path>` plus up to 10 parsed vitest/jest
failure lines so consumers can name the failing tests without re-running
the suite. A failed log write silently falls back to the previous
first-10-lines detail behavior — it never affects the check result.

### Waiving a permanently-failing check: `checks.<kind>.acknowledge`

Some check failures are not a signal to fix before pushing — they are a
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
  check keeps its own `acknowledged` status in `checks[]` — a caller reading
  only `ready`/`blockers` still sees `ready: true`, but anything reading
  `checks[]` sees the check did not actually pass.
- An acknowledged check never appears in `blockers[]` (only `fail` does) or
  `warnings[]` (only `warn` does) — it is visible *exclusively* through its
  own `status: "acknowledged"` entry in `checks[]`. A consumer that only
  quotes `blockers`/`warnings` and never scans `checks[]` will report a
  clean "READY" without ever surfacing that a failure was waived.
- The check's `message` is rewritten to include the reason
  (`"... — acknowledged: install-sh suite is linux-only, CI covers it"`),
  and a matching entry is added to `limitations`, so the waiver is visible
  in `--json` output.
- The human-output CLI prints a dedicated `Acknowledged (failed, but
  waived — not counted as a blocker):` section naming the check and reason.
  `preflight batch`'s one-line-per-repo summary has no room for that
  section, so it instead appends a compact `[n acknowledged]` marker to a
  repo's line when that repo has one or more acknowledged checks.

It is never silent about a REJECTED acknowledge: `acknowledge` requires a
non-empty string, and a present-but-unusable value (`{ "acknowledge": "" }`,
`{ "acknowledge": 12345 }`, etc.) is rejected — the check is left exactly as
it would be without an acknowledge (still a blocker if it failed), and the
rejection is reported once per check kind as a `limitations` entry, so a
typo'd config can never silently waive a real failure. A bare `{}` (no
`acknowledge` key at all) is a *different* case: it carries nothing to
reject, so it is not reported anywhere — the check simply runs enabled,
identical to `true`, with no acknowledge behavior in play.

**Deliberate boundaries:**
- Scoped to checks that failed (`fail`); a `pass`/`warn`/`skip` result is
  already non-blocking and is left untouched.
- Applies to the `checks.*` boolean toggles (`gitState`, `lint`,
  `typecheck`, `test`, `audit`, `commitConvention`, `tdd`) — one reason
  acknowledges every check of that kind for the whole run (e.g. every
  `commands.test` entry), not a single named sub-check.
- **Not supported** for `ciSimulation` (its toggle stays a plain boolean —
  acknowledging CI-simulation behavior is out of scope for this feature) or
  for `customChecks` (which already have their own per-check
  `failOnError: false` waiver instead).
- **Not supported** for `secretDetection` either (its toggle also stays a
  plain boolean, Orchestrator decision D-013): every other kind above waives
  the whole check for the run, but a secret-detection finding is not
  interchangeable that way — one `acknowledge` reason would blind every
  *future* secret in the repo, not just the finding an operator actually
  reviewed. Use `secretAllowlist` (a `path` or `path:line` entry) or an
  inline `pragma: allowlist secret` comment instead, both scoped to one
  specific, already-reviewed finding — see "Secret detection: obvious
  test-fixture values don't block" below. A configured but ignored
  `checks.secretDetection.acknowledge` is reported in `limitations` (not
  silently dropped), pointing at these alternatives.

### Secret detection: obvious test-fixture values don't block

A secret-shaped match (`TOKEN = "..."`, `apiKey = "..."`, etc.) is
downgraded from `fail` to a non-blocking `warn` when **both** of these
hold, regardless of diff scope or `secretDetectionStrict`:

- the file lives under a directory literally named `test` or `tests`
  (e.g. `tests/test_notify_planforge.py`), and
- the matched value itself — immediately after the `:`/`=` and an optional
  quote — starts with `test-`, `test_`, `dummy-`, `dummy_`, `fake-`, or
  `fake_` (e.g. `"test-planforge-bot-token"`).

A line carrying an unambiguous credential shape — a `ghp_...` token, a PEM
private-key header, or an AWS access key ID (the `AKIA`/`ASIA`/`ABIA`/
`ACCA`/`A3T...` prefix family) — always blocks regardless of either
condition above; the escape hatch there is `secretAllowlist` or the
inline `pragma: allowlist secret` comment, not this heuristic.

This is deliberately narrow on both axes so it cannot mask a real secret:
a realistic-looking value outside any `test`/`tests` directory still
blocks, and a realistic-looking value *inside* `tests/` that doesn't carry
one of those prefixes still blocks too — being under a test directory
alone is not sufficient. It does not cover other test-directory
conventions (`__tests__`, `spec`, `e2e`, ...) or a fixture-looking prefix
that isn't the assigned value itself; widen `secretAllowlist` or an inline
`pragma: allowlist secret` comment (see above) for those instead.

## Skill templates

Reusable starting points for installing or adapting `agent-preflight` into agent-specific workflows. Source repo: `https://github.com/LanNguyenSi/agent-preflight`. Template path: `templates/skills/<skill-name>`.

- [agent-preflight](./templates/skills/agent-preflight/SKILL.md)
- [agent-preflight-opencode](./templates/skills/agent-preflight-opencode/SKILL.md)
- [agent-preflight-claude](./templates/skills/agent-preflight-claude/SKILL.md)

## Building a release bundle

```bash
make release-bundle
```

Produces `out/release/agent-preflight-v<version>-bundle.tar.gz` plus a `.sha256`. Bundle installs require `node` but not `npm`. After install, `preflight` and `preflight-sandbox` are on `~/.local/bin`.

## Requirements

- Node.js 18+
- [act](https://github.com/nektos/act) for local CI simulation in host mode
- Stack-specific tools (`ruff`, `mypy`, `pytest`, `composer`, `phpunit`, `mvn`, `gradle`) for host-mode checks against those stacks
- Docker for sandbox mode

## License

MIT
