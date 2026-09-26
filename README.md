# agent-preflight

Validate your repo locally before pushing, with a confidence score an agent can read.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge), generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit), guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)

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

Checks: 9 | Duration: 20544ms
```

`--json` prints the same result as a structured object (`ready`, `confidence`, `blockers`, `warnings`, `limitations`, `durationMs`, `timestamp`) for an agent to parse. `run --json` and `batch --json` both write their full JSON envelope before exiting; a consumer piping either command's output must read stdout concurrently with the process, not wait for exit.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow and dev setup.

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
