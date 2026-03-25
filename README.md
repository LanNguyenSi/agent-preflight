# agent-preflight

CI preflight validation for AI agents — run local checks before pushing, get structured feedback with confidence scoring.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) · Generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) · Guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)

## The Problem

AI agents can change code. They can't easily verify whether the pipeline will accept it. The typical loop:

```
change code → push → wait for CI → fix → repeat
```

agent-preflight breaks that cycle by validating locally first.

## What It Does

Runs a hybrid set of checks before you push:

| Check | What it catches | Tool | Speed |
|-------|----------------|------|-------|
| TypeScript typecheck | Type errors | tsc | fast |
| Lint | Code quality issues | eslint / ruff | fast |
| Dependency audit | Known CVEs in dependencies | npm audit | fast |
| **Secret detection** | API keys, tokens, private keys in source files | pattern scan | fast |
| Commit convention | Non-conventional commit messages | git log | fast |
| CI simulation | Workflow failures before push | act (optional) | slow |

> **Secret detection** scans all source files for patterns matching API keys, tokens, and private keys. Placeholder/example values (e.g. `your_api_key_here`) are ignored.

Returns structured JSON with a **confidence score** (0–1) and explicit **limitations** — so agents know what was and wasn't validated.

## Installation

### From source (recommended for now)

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
make setup       # install + build
make run         # check current directory
make batch DIR=~/git  # check all repos
```

### npm (coming soon)

```bash
npm install -g agent-preflight
```

## Usage

### Single repo

```bash
# Run in current directory
preflight run

# Run against a specific repo
preflight run ./my-project

# JSON output (for agent consumption)
preflight run ./my-project --json

# Enable act-based CI simulation (requires act)
preflight run --ci-simulation
```

### Batch mode (multiple repos)

Inspired by [git-batch-cli](https://github.com/LanNguyenSi/git-batch-cli):

```bash
# Run against all repos in a directory
preflight batch ~/git

# Filter by name pattern
preflight batch ~/git --only "frost-*"
preflight batch ~/git --exclude "*-playground"

# JSON output
preflight batch ~/git --json
```

## Output

```
✅ preflight: READY (confidence: 87%)

Warnings:
  ⚠ 3 recent commits don't follow conventional format

Limitations (not validated locally):
  ~ CI simulation skipped (enable with --ci-simulation, requires act)
  ~ secret detection uses pattern matching; not exhaustive

Checks: 5 | Duration: 234ms
```

### JSON output format

```json
{
  "ready": true,
  "confidence": 0.87,
  "checks": [...],
  "blockers": [],
  "warnings": ["3 recent commits don't follow conventional format"],
  "limitations": [
    "CI simulation skipped (requires act)",
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
  "checks": {
    "lint": true,
    "typecheck": true,
    "test": true,
    "audit": true,
    "ciSimulation": false,
    "commitConvention": true,
    "secretDetection": true
  },
  "commitConvention": "conventional",
  "actFlags": ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"]
}
```

## Requirements

- Node.js 18+
- [act](https://github.com/nektos/act) (optional, for CI simulation)
- `ruff` (optional, for Python lint checks)

## License

MIT
