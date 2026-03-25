# agent-preflight

CI preflight validation for AI agents. Run local checks before pushing and get structured feedback with confidence scoring.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) · Generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) · Guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)

## The Problem

AI agents can change code. They cannot easily verify whether the pipeline will accept it. The typical loop:

```text
change code -> push -> wait for CI -> fix -> repeat
```

agent-preflight breaks that cycle by validating locally first.

## What It Does

Runs a hybrid set of checks before you push:

| Check | What it catches | Tool | Speed |
|-------|----------------|------|-------|
| Lint | Code quality issues | eslint / ruff / pint / phpcs / repo-native scripts | fast |
| Typecheck | Type issues and broken builds | tsc / mypy / phpstan / psalm / mvn compile / gradle classes | fast |
| Test | Broken test suites | npm test / pytest / phpunit / mvn test / gradle test | medium |
| Dependency audit | Known CVEs in dependencies | npm audit / pip-audit / composer audit | fast |
| Secret detection | API keys, tokens, private keys in source files | pattern scan | fast |
| Commit convention | Non-conventional commit messages | git log | fast |
| CI simulation | Workflow failures before push | act (optional) | slow |

Returns structured JSON with a confidence score (0-1) and explicit limitations so agents know what was and was not validated.

## Installation

### From source

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
make setup
make run
make batch DIR=~/git
make sandbox
```

### npm

```bash
npm install -g agent-preflight
```

## Usage

### Single repo

```bash
preflight run
preflight run ./my-project
preflight run ./my-project --json
preflight run --ci-simulation
```

### Batch mode

Inspired by [git-batch-cli](https://github.com/LanNguyenSi/git-batch-cli):

```bash
preflight batch ~/git
preflight batch ~/git --only "frost-*"
preflight batch ~/git --exclude "*-playground"
preflight batch ~/git --json
```

### Sandbox runtime

The optional sandbox image gives you a reproducible runtime with common cross-stack tooling already installed:

- `act`
- Node.js 20
- Python with `ruff`, `mypy`, `pytest`, `pip-audit`
- PHP CLI and Composer
- Java 17, Maven and Gradle

```bash
# Build image + run current repo in Docker
make sandbox

# Print the generated docker command
./agent-preflight-sandbox --print

# Allow act inside the container to talk to the host Docker daemon
./agent-preflight-sandbox --build --docker-socket -- run /workspace --ci-simulation
```

The wrapper mounts the current Git root at `/workspace`. `--docker-socket` is only required when you want `act` inside the sandbox.

## Output

```text
✅ preflight: READY (confidence: 87%)

Warnings:
  ⚠ 3 recent commits don't follow conventional format

Limitations (not validated locally):
  ~ CI simulation skipped (enable with --ci-simulation, requires act)
  ~ secret detection uses pattern matching; not exhaustive

Checks: 6 | Duration: 234ms
```

### JSON output

```json
{
  "ready": true,
  "confidence": 0.87,
  "checks": [],
  "blockers": [],
  "warnings": ["3 recent commits don't follow conventional format"],
  "limitations": [
    "CI simulation skipped (enable with checks.ciSimulation: true, requires act)",
    "secret detection uses pattern matching; not exhaustive"
  ],
  "durationMs": 234,
  "timestamp": "2026-03-25T17:00:00.000Z"
}
```

## Configuration

Create `.preflight.json` in your repo root:

```json
{
  "workingDir": ".",
  "checks": {
    "lint": true,
    "typecheck": true,
    "test": true,
    "audit": true,
    "ciSimulation": false,
    "commitConvention": true,
    "secretDetection": true
  },
  "commands": {
    "lint": ["npm run lint"],
    "typecheck": ["npx tsc --noEmit"],
    "test": ["npm run test"],
    "audit": ["npm audit --json"]
  },
  "commitConvention": "conventional",
  "actFlags": ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"],
  "customChecks": [
    {
      "name": "smoke",
      "command": "make smoke",
      "failOnError": false
    }
  ]
}
```

Examples:

```json
{
  "workingDir": "apps/api",
  "commands": {
    "lint": ["vendor/bin/pint --test"],
    "typecheck": ["vendor/bin/phpstan analyse"],
    "test": ["vendor/bin/phpunit"],
    "audit": ["composer audit --format=json"]
  }
}
```

If no custom commands are configured, agent-preflight auto-detects common Node, Python, PHP and Java manifests and chooses reasonable defaults.

## Skill Templates

The repo also ships reusable skill templates for agent workflows:

- [agent-preflight](./templates/skills/agent-preflight/SKILL.md)
- [agent-preflight-opencode](./templates/skills/agent-preflight-opencode/SKILL.md)
- [agent-preflight-claude](./templates/skills/agent-preflight-claude/SKILL.md)

They are meant as starting points for installing or adapting `agent-preflight` into agent-specific workflows.
Each template now includes its canonical install source:

- source repo: `https://github.com/LanNguyenSi/agent-preflight`
- template path inside repo: `templates/skills/<skill-name>`

## Requirements

- Node.js 18+
- [act](https://github.com/nektos/act) for local CI simulation in host mode
- stack-specific tools such as `ruff`, `mypy`, `pytest`, `composer`, `phpunit`, `mvn`, `gradle` for host mode
- Docker for sandbox mode

## License

MIT
