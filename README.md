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
| Git state | Dirty worktrees and pushes from protected branches | git | fast |
| Lint | Code quality issues | eslint / ruff / pint / phpcs / repo-native scripts | fast |
| Typecheck | Type issues and broken builds | tsc / mypy / phpstan / psalm / mvn compile / gradle classes | fast |
| Test | Broken test suites | npm test / pytest / phpunit / mvn test / gradle test | medium |
| Dependency audit | Known CVEs in dependencies | npm audit / pip-audit / composer audit | fast |
| Secret detection | API keys, tokens, private keys in source files | pattern scan | fast |
| Commit convention | Non-conventional commit messages | git log | fast |
| CI simulation | Workflow failures before push | act (optional) | slow |

Returns structured JSON with a confidence score (0-1) and explicit limitations so agents know what was and was not validated.

`clean-worktree` is treated as a blocker because local changes can make the result diverge from what will actually be pushed. `protected-branch` is reported as a warning because some repositories still use direct-push workflows.

## Installation

### From source

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
./install.sh
source ~/.bashrc
```

### npm

```bash
npm install -g @lannguyensi/agent-preflight
```

The published npm package is scoped (`@lannguyensi/agent-preflight`) but the binary it installs is still `preflight` and the project name is `agent-preflight` — the scope is only an npm-namespace artefact (npm's typo-squatting protection blocks the unscoped name).

### From a release bundle

```bash
tar -xzf agent-preflight-v0.1.0-bundle.tar.gz
cd agent-preflight-v0.1.0-bundle
./install.sh
source ~/.bashrc
```

Bundle installs require `node`, but not `npm`.
After a source install or bundle install, `preflight` and `preflight-sandbox` are available from `~/.local/bin`.

## Usage

### Single repo

```bash
preflight run
preflight run ./my-project
preflight run ./my-project --json
preflight run ./my-project --setup
preflight run --ci-simulation
```

### Batch mode

Inspired by [git-batch-cli](https://github.com/LanNguyenSi/git-batch-cli):

```bash
preflight batch ~/git
preflight batch ~/git --only "frost-*"
preflight batch ~/git --exclude "*-playground"
preflight batch ~/git --setup
preflight batch ~/git --json
```

### Sandbox runtime

The optional sandbox runtime gives you a reproducible image with common cross-stack tooling already installed:

- `act`
- Node.js 20
- Python with `ruff`, `mypy`, `pytest`, `pip-audit`
- PHP CLI and Composer
- Java 17, Maven and Gradle

```bash
# Run current repo in Docker. The first run auto-detects the repo profile and builds a matching local image if needed.
preflight sandbox

# Print the generated docker command
preflight sandbox --print

# Allow act inside the container to talk to the host Docker daemon
preflight sandbox --docker-socket --ci-simulation --setup

# Force a rebuild explicitly
preflight sandbox --build
```

`preflight sandbox` mounts the current Git root at `/workspace` when no path is passed. `--docker-socket` is only required when you want `act` inside the sandbox.
The image name is derived from detected capabilities such as Node, Python, PHP, Java, Symfony and `--ci-simulation`, so switching repositories can trigger a different local image automatically.
CI simulation uses a default `act` platform mapping for `ubuntu-latest` unless you override `actFlags` in `.preflight.json`.
The legacy wrapper `./agent-preflight-sandbox` is still available for direct use from a checkout.

### Building a release bundle

```bash
make release-bundle
```

This creates:

- `out/release/agent-preflight-v<version>-bundle.tar.gz`
- `out/release/agent-preflight-v<version>-bundle.tar.gz.sha256`

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
    "gitState": true,
    "lint": true,
    "typecheck": true,
    "test": true,
    "audit": true,
    "ciSimulation": false,
    "commitConvention": true,
    "secretDetection": true
  },
  "setup": {
    "enabled": false
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

### Monorepos and npm workspaces

For npm/yarn/pnpm workspace layouts where the root has no `tsconfig.json` or `.eslintrc` (the per-package configs live under `packages/*` or `apps/*`), declare `scripts.typecheck` and `scripts.lint` in the root `package.json` that fan out to the workspaces — agent-preflight will prefer these over root-level tool detection:

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

This way a per-package type error surfaces as a real `fail`, not a silent `limitation`. For pnpm use `pnpm -r typecheck`; for yarn, `yarn workspaces foreach run typecheck`. Use `commands.*` in `.preflight.json` if you need a different invocation.

### Sandbox overrides

`preflight sandbox` derives its image profile from the target repo:

- Node / TypeScript from `package.json` and `tsconfig.json`
- Python from `pyproject.toml`, `setup.py`, or `requirements.txt`
- PHP from `composer.json`
- Symfony from `symfony.lock`, `bin/console`, or `symfony/*` Composer packages
- Java from Maven or Gradle manifests
- PHP extension apt packages from Composer `ext-*` requirements when they are known

For repo-specific extras that cannot be inferred safely, use `.preflight.json`:

```json
{
  "sandbox": {
    "aptPackages": ["libvips-tools", "php-imagick"],
    "pipPackages": ["bandit"]
  }
}
```

### Setup phase

`agent-preflight` includes an optional conservative setup phase before checks.
Enable it with `--setup` or in `.preflight.json`:

```json
{
  "setup": {
    "enabled": true
  }
}
```

When enabled, it can run:

- Node: runs `npm ci` when `package-lock.json` exists and `node_modules/` is missing
- Python: creates `.preflight-venv` and installs `requirements.txt` when present
- PHP: runs `composer install --no-interaction --no-progress` when `vendor/` is missing
- Maven: runs dependency warmup before Java compile/test checks
- Gradle: runs `classes testClasses` before Java compile/test checks

This remains intentionally conservative. It only runs when the project files make the setup step unambiguous. For more specialized setups, use explicit `commands.*` overrides in `.preflight.json`.

### Behavior notes

- Dependency/bootstrap setup is opt-in. Use `--setup` or set `"setup": { "enabled": true }` in `.preflight.json` if you want `agent-preflight` to prepare missing dependencies before running checks.
- Secret detection scans real `.env` files such as `.env` and `.env.local`. Keep example values in template files like `.env.example` or `.env.template`.

## Git Hygiene

By default `agent-preflight` also inspects repository state:

- `protected-branch`: warns when `HEAD` is on one of the configured protected branches
- `clean-worktree`: fails when tracked or untracked local changes are present

You can tune the protected branch list in `.preflight.json`:

```json
{
  "protectedBranches": ["main", "master", "develop"]
}
```

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
