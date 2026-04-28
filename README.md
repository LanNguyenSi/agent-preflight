# agent-preflight

Validate your repo locally before pushing, with a confidence score an agent can read.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge), generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit), guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)

agent-preflight runs lint, typecheck, test, dependency audit, secret detection, commit-convention, and (optionally) a real `act`-driven CI simulation against your working tree, then returns a structured result with a confidence score between 0 and 1. It exists to break the "change, push, wait for CI, fix, repeat" loop that AI agents run into when they cannot tell whether the pipeline will accept their work. Local validation, JSON output, deterministic scoring.

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

## Common commands

```bash
preflight run                              # current dir
preflight run ./my-project                 # explicit path
preflight run ./my-project --json          # machine-readable
preflight run --ci-simulation              # add act-based workflow run
preflight run --setup                      # bootstrap deps before checks

preflight batch ~/git                      # every repo under a root
preflight batch ~/git --only "frost-*"
preflight batch ~/git --exclude "*-playground"

preflight sandbox                          # run inside a docker image
preflight sandbox --print                  # show the docker command
preflight sandbox --docker-socket --ci-simulation
```

`preflight batch` is inspired by [git-batch-cli](https://github.com/LanNguyenSi/git-batch-cli) and runs the single-repo path against every git repo under the given root.

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
