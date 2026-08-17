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

**Timeouts and long runs.** The MCP SDK's default request timeout is 60s; a real `preflight_run` (let alone `preflight_batch`, which loops over every repo under `root`) can easily take longer. Both tools send a `notifications/progress` ping roughly every 10s while the underlying checks are still running, but only when your client attaches a `progressToken` to the request (most MCP clients do this automatically when you pass an `onprogress` callback / enable progress-aware timeouts, e.g. `resetTimeoutOnProgress`). If your client doesn't support that, raise its request timeout for these two tools instead — `preflight_batch` in particular is expected to be long-running.

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

If no commands are configured, agent-preflight auto-detects common Node, Python, PHP, and Java manifests and picks reasonable defaults. The full toggle, override, and monorepo guidance lives in [docs/checks.md](docs/checks.md). Sandbox image profiles, apt packages, and act flags are covered in [docs/architecture.md](docs/architecture.md#sandbox).

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
