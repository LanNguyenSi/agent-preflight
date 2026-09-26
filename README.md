# agent-preflight

Validate your repo locally before pushing, with a confidence score an agent can read.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge), generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit), guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/agent-engineering-playbook)

## Overview

agent-preflight runs lint, typecheck, test, dependency audit, secret detection, commit-convention, and (optionally) an `act`-based CI dry-run that validates your GitHub Actions workflow plan against your working tree, then returns a structured result with a confidence score between 0 and 1. It exists to break the "change, push, wait for CI, fix, repeat" loop that AI agents run into when they cannot tell whether the pipeline will accept their work. Local validation, JSON output, deterministic scoring.

## Key features

- Lint, typecheck, test, dependency audit, secret detection, and commit-convention checks with auto-detected commands for Node, Python, PHP, and Java
- Optional `act`-based CI dry-run that validates your GitHub Actions workflow plan
- A deterministic confidence score (0-1) instead of a plain pass/fail
- Human-readable or `--json` output for direct agent consumption
- An MCP server (`preflight-mcp`) exposing the same runner in-process
- `preflight batch` to run across every git repo under a root
- `preflight sandbox` to run the same checks inside a Docker image

## Quick start

Requires Node.js 18+; [act](https://github.com/nektos/act) and Docker are only needed for the optional CI simulation and sandbox modes. Host-mode checks need the target stack's own tools on `PATH` (`ruff`, `mypy`, `pytest`, `composer`, `mvn`, and so on); sandbox mode bundles those into the Docker image instead. `install.sh` puts `preflight`, `preflight-sandbox`, and `preflight-mcp` in `~/.local/bin` (override with `PREFLIGHT_BIN_DIR`).

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
./install.sh
source ~/.bashrc

# run against any local repo (or the current directory)
preflight run .
```

Or install via npm (the published package is scoped, `@lannguyensi/agent-preflight`, but the binary is still `preflight`):

```bash
npm install -g @lannguyensi/agent-preflight
preflight run .
```

## Usage

```bash
preflight run                              # current dir
preflight run ./my-project --json          # machine-readable
preflight run --ci-simulation              # add act --dryrun CI plan validation
preflight batch ~/git                      # every repo under a root
preflight sandbox                          # run inside a docker image
```

A run prints a summary and exits non-zero when not ready:

```
preflight: READY (confidence: 89%)

Warnings:
  4 recent commit(s) don't follow conventional format

Limitations (not validated locally):
  secret detection uses pattern matching; not exhaustive
  CI simulation skipped (enable with checks.ciSimulation: true, requires act)

Checks: 9 | Duration: 20544ms
```

`--json` prints the same result as a structured object (`ready`, `confidence`, `checks`, `blockers`, `warnings`, `limitations`, `durationMs`, `timestamp`) for an agent to parse. `run --json` and `batch --json` both write their full JSON envelope before exiting; a consumer piping either command's output must read stdout concurrently with the process, not wait for exit.

Security: a target repo's `.preflight.json` can define shell commands that run on your machine, so only run `preflight batch` (or `run`/`sandbox`/the MCP server) against repositories you trust; see [docs/checks.md](docs/checks.md#custom-checks) for the full note.

## Documentation

- [docs/checks.md](docs/checks.md): what each check verifies, toggles, auto-detection, monorepo setup, and the build-required test classification, waiver, and secret-detection-fixture rules
- [docs/confidence-scoring.md](docs/confidence-scoring.md): the scoring model, default weights, and reading the result
- [docs/architecture.md](docs/architecture.md): CLI internals, the run/batch/sandbox pipeline, act integration, and the MCP server
- [docs/integration.md](docs/integration.md): wiring agent-preflight into agent-tasks, agent-relay, and harness as a claim gate
- [docs/secret-scanner-investigation.md](docs/secret-scanner-investigation.md): investigation into the secret-detection engine's current regex approach versus gitleaks and trufflehog
- [docs/ways-of-working.md](docs/ways-of-working.md): contributor conventions (definition of done, CLI UX rules)
- Skill templates for adapting agent-preflight into agent workflows: [agent-preflight](./templates/skills/agent-preflight/SKILL.md), [agent-preflight-opencode](./templates/skills/agent-preflight-opencode/SKILL.md), [agent-preflight-claude](./templates/skills/agent-preflight-claude/SKILL.md)

## Development and contributing

```bash
npm install
npm run build
npm test
npm run lint
```

`make release-bundle` produces `out/release/agent-preflight-v<version>-bundle.tar.gz` plus a `.sha256`; bundle installs require `node` but not `npm`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow and dev setup.

## License

MIT
