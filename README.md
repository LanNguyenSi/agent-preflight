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

**Security: the target repo is not just data.** Its `.preflight.json` can define shell commands (`customChecks[].command`, `commands.lint`/`typecheck`/`test`/`audit`) that these tools execute on the machine running the MCP server. Only point `preflight_run`/`preflight_batch` at repositories you trust — this is the same execution surface `preflight run`/`preflight batch` already have on the CLI, just now reachable by whatever agent/tool is calling the MCP server.

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
  "setup": { "enabled": false },
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

### Build-required test classification: `dist/` missing before a build

Some Node workspaces only pass their own tests after a build: a test that
imports its package's `dist/` output fails loudly (a bare `Cannot find
module` or `ENOENT` naming a path through `dist/`) in a fresh checkout that
has not been built yet, even though the repo's own CI always runs a build
step first. Treating that as a blocking `fail`, the default before this
feature, makes a correct push look broken purely because preflight itself
skipped a build step the repo's own CI never skips.

The default `npm-test` check (the auto-detected `npm run test`; a
`commands.test` override in `.preflight.json` is not covered) now
classifies a failure this way as a distinct, named outcome instead of a
blocker: `status: "skip"` with a message naming the missing artifact and
the remedy, for example:

```
npm test not evaluated: build required before test (Error: Cannot find
module './dist/index.js'); run `npm run build` first (or rerun preflight
with `--setup`, which builds automatically when this repo's CI shows
build-before-test)
```

The classification only fires on concrete evidence in the check's captured
output, never on a generic non-zero exit, so a genuine test failure always
stays a blocking `fail`:

- Node's own `Cannot find module '<path>'` where `<path>` runs through a
  `dist/` segment.
- An `ENOENT ... open '<path>'` naming a `dist/` path, restricted to a real
  module-resolution failure: the path must look like a require/import
  entry point (`.js`/`.mjs`/`.cjs`/`.d.ts`/`.json`), and the captured
  output must carry a `Require stack:` or `ERR_MODULE_NOT_FOUND` marker. A
  plain `fs` read of some other file that happens to live under `dist/` (a
  cache JSON, a fixture the test itself writes there) is not "build
  required" just because the path runs through `dist/`.
- A workspace's own thrown/assertion message that states the precondition
  on one line: a `dist/` mention, a "missing"/"not found"/"does not exist"
  phrase, and an explicit `npm run build` mention, all together.

A failure that only mentions "dist" or "missing" in isolation, an
assertion comparing two strings that happen to contain "dist", for example,
is never enough by itself and stays a blocker. Neither path-bearing pattern
above is trusted from just anywhere in the output, either: only a line
that itself looks like Node/npm's own error output (starts with `Error:`,
`Cannot find module`, `ENOENT`, `at `, `Require stack:`, `npm error`, and
similar) counts, so a test runner's code frame echoing that same text as
quoted source (`125|     const output = "Error: Cannot find module
'./dist/index.js'";`) is never mistaken for the real error. A matched path
is further required to actually be reachable by a build: a bare module
specifier with no repo-relative or absolute shape (ordinary
`node_modules` resolution, e.g. `Cannot find module 'lodash'`), a path
through `node_modules` even when absolute, an absolute path outside the
repo root, or a path whose `dist/` directory already exists on disk (the
workspace HAS been built; a missing file inside an already-built `dist/`
is a different, unrelated bug) are all rejected.

An npm-workspaces monorepo's `npm test` fan-out is classified **per
workspace**, not as one blob: the combined output is split at each
workspace's own `> <name>@<version> <script>` preamble, and the check is
only downgraded when EVERY workspace whose own segment actually failed
carries build-required evidence. One workspace missing its build alongside
a different, genuinely broken workspace in the same run stays a blocking
`fail`; the genuine failure is never hidden behind the other workspace's
build-required evidence. A single-package repo (no workspace fan-out at
all) is classified as one blob, same as before this per-workspace split.

The remedy named in the skip message depends on what could actually fix
it: when the repo's root `package.json` has a `build` script, the message
names `npm run build` and `--setup` (`--setup` only ever runs the build at
the repo root; see below). When it does not but the classifier could
attribute the failure to specific workspace(s), the message names a
workspace-scoped build instead (`npm run build -w <name>` for exactly one
workspace, `npm run build --workspaces --if-present` for more than one),
since `--setup` cannot help here. When neither is known, the message says
plainly that no `build` script was found and the check was not evaluated,
rather than naming a command that would not exist.

Alongside the named outcome, `--setup` now also runs the repo's own build
automatically before the test check, but only when both hold: `package.json`
has a `build` script, AND `.github/workflows/ci.yml` shows a `run:` step
invoking `npm run build` (or the `yarn`/`pnpm` equivalent) before a step
invoking the test script, by raw line order in that one file. This is a
deliberately conservative, best-effort read, not a real GitHub Actions
execution-graph evaluator:

- Only `.github/workflows/ci.yml` by that exact name is read; other
  workflow files, reusable workflows, and composite actions are not
  consulted.
- Only single-line `run: <command>` steps are recognized; a YAML block
  scalar (`run: |` followed by more lines) is not parsed for its body. A
  `run:` step whose value is itself a shell comment (`run: # npm run
  build`) or that only echoes a string (`run: echo 'npm run build is
  documented'`) is recognized and skipped, since neither actually invokes
  the build.
- Ordering is by line number in the file, not GitHub Actions' actual
  job/`needs:` execution graph: a multi-job workflow whose real
  build-before-test order comes from job dependencies rather than from
  top-to-bottom file order is not modeled, including a build step that
  sits in a job unrelated to the one that runs tests.

These gaps do not all fail the same direction. A false **miss** (a real
build-before-test convention this reader cannot see, e.g. a `run: |` block
scalar or a reusable workflow) only costs the extra manual `npm run build`
this feature exists to avoid; `--setup` behaves exactly as it did before
this feature (dependency install only, via `npm ci`), and the test check
falls back to the named skip outcome above. A false **hit** (an unrelated
job's build step read as "before" the test job by line order alone) only
costs a redundant rebuild under `--setup`: harmless, but not free. Neither
direction causes `--setup` to skip a build the repo's real CI relies on.
This repo's own CI has no build step at all (`vitest` runs the TypeScript
source directly), and is exercised in the test suite as a check against a
false-hit default.

`--setup`'s build step can itself fail: the repo genuinely does not
compile right now. When it does (a non-zero exit or a timeout), the test
check's own subsequent "dist missing" failure is **not** reclassified to
skip: that would misreport a real, newly-observed break as the innocuous
"just hasn't been built yet" case this feature exists to unblock. The test
check instead stays a blocking `fail`, with its message naming which
(build failure vs. timeout) and pointing at the persisted build log when
one was written (same log-persistence mechanism described below).

Confidence score: a build-required skip is scored exactly like any other
`skip` outcome (see [docs/confidence-scoring.md](docs/confidence-scoring.md)).
Its weight (0.2 for the test check) counts toward the confidence
denominator but not the numerator, and the accompanying `limitations` entry
adds the usual 0.03 penalty (capped at 0.2 total across all limitations).
It is not scored as a `pass`, and it is not scored more harshly than an
`npm-audit` skip for the same reason (no report to judge).

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
