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

If no commands are configured, agent-preflight auto-detects common Node, Python, PHP, and Java manifests and picks reasonable defaults. The full toggle, override, and monorepo guidance lives in [docs/checks.md](docs/checks.md). Sandbox image profiles, apt packages, and act flags are covered in [docs/architecture.md](docs/architecture.md#sandbox). The `npm-audit` check runs with a bounded timeout and reports `skip` (not `warn`) with a `limitations` entry when the registry's advisory endpoint times out or is unreachable, or npm reports a registry-side error, so an outage there never hangs the run or is misread as a real finding; a local npm failure unrelated to the registry (e.g. no lockfile present) stays a `warn` naming that failure instead.

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
