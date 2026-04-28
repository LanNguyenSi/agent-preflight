# Checks reference

Every check `agent-preflight` can run, what it verifies, and when it fires. Each check returns a `pass`, `fail`, `warn`, or `skip` and contributes to the overall confidence score (see [confidence-scoring.md](./confidence-scoring.md)).

## Default checks

| Check | Kind | What it catches | Tools tried | Status semantics |
|-------|------|-----------------|-------------|------------------|
| Git state, clean worktree | `git-state` | Tracked or untracked local changes that would diverge from what gets pushed | `git status --porcelain` | `fail` (blocker) when dirty |
| Git state, protected branch | `git-state` | Pushing directly to `main`, `master`, or other configured branches | `git rev-parse --abbrev-ref HEAD` | `warn`, since some workflows allow direct push |
| Lint | `lint` | Code-quality issues | `eslint`, `ruff`, `pint`, `phpcs`, `mvn checkstyle`, plus `package.json` `scripts.lint` and other repo-native scripts | `fail` on lint errors |
| Typecheck | `typecheck` | Type errors and broken builds | `tsc --noEmit`, `mypy`, `phpstan`, `psalm`, `mvn compile`, `gradle classes` | `fail` on type errors |
| Test | `test` | Broken test suites | `npm test`, `pytest`, `phpunit`, `mvn test`, `gradle test` | `fail` when tests fail |
| Dependency audit | `audit` | Known CVEs in dependencies | `npm audit --json`, `pip-audit`, `composer audit` | `fail` on high-severity findings |
| Secret detection | `secret-detection` | API keys, tokens, private keys committed to source files or real `.env` files | regex pattern scan | `fail` on a hit |
| Commit convention | `commit-convention` | Recent commit messages that do not follow conventional commits | `git log` | `warn` only |
| TDD signal | `tdd` | Source files changed in the last commit without a paired test file | `git diff HEAD~1..HEAD`, filesystem scan | `warn` to nudge, never blocks |
| CI simulation (opt-in) | `ci-simulation` | Workflow failures before push | `act` against `.github/workflows/` | `fail` when act exits non-zero |
| Custom checks | `custom` | Anything you can express as a shell command | user-provided `command` | `fail` or `warn` per `failOnError` |

## Status semantics

- `pass` and `skip` never block.
- `warn` shows in output but does not move `ready` to `false`.
- `fail` is a blocker, `ready` becomes `false`, and the CLI exits non-zero.

`clean-worktree` is a blocker because local modifications make the result diverge from what will actually be pushed. `protected-branch` is a warning because direct-push workflows still exist.

## Auto-detection

If no `commands.*` entries are configured, the runner walks the repo root for known manifests and picks defaults:

- Node, TypeScript: `package.json`, `tsconfig.json`
- Python: `pyproject.toml`, `setup.py`, `requirements.txt`
- PHP: `composer.json`
- Symfony: `symfony.lock`, `bin/console`, or `symfony/*` Composer packages
- Java: Maven (`pom.xml`) or Gradle (`build.gradle`, `build.gradle.kts`) manifests

Unknown stacks emit a `limitation` rather than a `fail`, so the runner still produces a score. See [confidence-scoring.md](./confidence-scoring.md) for how skips and limitations affect the result.

## Monorepos and workspaces

For npm, yarn, or pnpm workspace layouts where the root has no `tsconfig.json` or `.eslintrc` (per-package configs live under `packages/*` or `apps/*`), declare `scripts.typecheck` and `scripts.lint` in the root `package.json` that fan out to the workspaces. `agent-preflight` prefers these over root-level tool detection:

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

This way a per-package type error surfaces as a real `fail`, not a silent `limitation`. For pnpm, use `pnpm -r typecheck`. For yarn, `yarn workspaces foreach run typecheck`. Use `commands.*` in `.preflight.json` if you need a different invocation.

## Toggles

Every check can be turned off in `.preflight.json`:

```json
{
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
  "protectedBranches": ["main", "master", "develop"],
  "commitConvention": "conventional"
}
```

CLI flags `--no-audit`, `--no-secrets`, and `--ci-simulation` override the file for one run.

## Custom checks

Custom checks let you wire in anything else as a shell command:

```json
{
  "customChecks": [
    { "name": "smoke", "command": "make smoke", "failOnError": false },
    { "name": "schema-diff", "command": "scripts/check-schema.sh", "failOnError": true }
  ]
}
```

`failOnError: false` downgrades a non-zero exit to a `warn` so optional checks still surface without blocking the run.

## Setup phase

Optional bootstrap before checks. Enable with `--setup` or `setup.enabled: true` in `.preflight.json`. When on:

- Node: `npm ci` if `package-lock.json` exists and `node_modules/` is missing
- Python: creates `.preflight-venv` and installs `requirements.txt` when present
- PHP: `composer install --no-interaction --no-progress` when `vendor/` is missing
- Maven: dependency warmup before the Java compile and test checks
- Gradle: `classes testClasses` before the Java compile and test checks

The setup phase is intentionally conservative. It only runs when the project files make the step unambiguous. For specialized setups, use explicit `commands.*` overrides.

## Behavior notes

- Dependency bootstrap is opt-in. The runner never touches `node_modules/`, `vendor/`, or virtualenvs unless `--setup` is passed.
- Secret detection scans real `.env` files such as `.env` and `.env.local`. Keep example values in template files like `.env.example` or `.env.template`.
