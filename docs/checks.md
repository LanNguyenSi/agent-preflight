# Checks reference

Every check `agent-preflight` can run, what it verifies, and when it fires. Each check returns a `pass`, `fail`, `warn`, or `skip` and contributes to the overall confidence score (see [confidence-scoring.md](./confidence-scoring.md)).

## Default checks

| Check | Kind | What it catches | Tools tried | Status semantics |
|-------|------|-----------------|-------------|------------------|
| Git state, clean worktree | `git-state` | Tracked or untracked local changes that would diverge from what gets pushed | `git status --porcelain` | `fail` (blocker) when dirty |
| Git state, protected branch | `git-state` | Pushing directly to `main`, `master`, or other configured branches | `git rev-parse --abbrev-ref HEAD` | `warn`, since some workflows allow direct push |
| Lint | `lint` | Code-quality issues | `eslint`, `ruff`, `pint`, `phpcs`, plus `package.json` `scripts.lint` and other repo-native scripts (Java has no default linter; set `commands.lint`) | `fail` on lint errors |
| Typecheck | `typecheck` | Type errors and broken builds | `tsc --noEmit`, `mypy`, `phpstan`, `psalm`, `mvn compile`, `gradle classes` | `fail` on type errors |
| Test | `test` | Broken test suites | `npm test`, `pytest`, `phpunit`, `mvn test`, `gradle test` | `fail` when tests fail |
| Dependency audit | `audit` | Known CVEs in dependencies | `npm audit --json`, `pip-audit`, `composer audit` | `fail` on high-severity findings |
| Secret detection | `secret-detection` | API keys, tokens, private keys in source files | regex scan, git-aware + diff-scoped severity | `fail` only when the current change introduced the secret; `warn` for pre-existing, gitignored, docs, or non-git |
| Commit convention | `commit-convention` | Recent commit messages that do not follow conventional commits | `git log` | `warn` only |
| TDD signal | `tdd` | Source files changed in the last commit without a paired test file | `git diff HEAD~1..HEAD`, filesystem scan | `warn` to nudge, never blocks |
| CI simulation (opt-in) | `ci-simulation` | Workflow failures before push | `act` against `.github/workflows/` | `fail` when act exits non-zero |
| Custom checks | `custom` | Anything you can express as a shell command | user-provided `command` | `fail` or `warn` per `failOnError` |

## Status semantics

- `pass` and `skip` never block.
- `warn` shows in output but does not move `ready` to `false`.
- `fail` is a blocker, `ready` becomes `false`, and the CLI exits non-zero.
- `acknowledged` is a `fail` the operator explicitly waived via
  `checks.<kind>.acknowledge` in `.preflight.json` — never blocks, but
  stays visible with its own status and the waiver's reason (see the
  README's "Waiving a permanently-failing check" section).

`clean-worktree` is a blocker because local modifications make the result diverge from what will actually be pushed. `protected-branch` is a warning because direct-push workflows still exist.

## Auto-detection

If no `commands.*` entries are configured, the runner walks the repo root for known manifests and picks defaults:

- Node, TypeScript: `package.json`, `tsconfig.json`
- Python: `pyproject.toml`, `setup.py`, `requirements.txt`
- PHP: `composer.json` (Symfony repos use this generic PHP path; the check runners have no Symfony-specific branch, so Symfony is only detected for sandbox image profiles, see [architecture.md](./architecture.md#sandbox))
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

Instead of `true`/`false`, any toggle except `ciSimulation` can also be
`{ "acknowledge": "<reason>" }` to run the check but waive a `fail` result
as a non-blocking `acknowledged` status with the reason attached — see the
README's "Waiving a permanently-failing check" section for the full
contract (required non-empty reason, visibility guarantees, boundaries).

### Failure log directory override

`logDir` in `.preflight.json` overrides where a failing lint/typecheck/test/audit/custom check's complete stdout+stderr is persisted, in place of the default `~/.agent-preflight/logs`:

```json
{
  "logDir": ".preflight-logs"
}
```

A relative value resolves against the repo root (not `workingDir`, not `process.cwd()`); a leading `~/` expands to the home directory; an absolute path is used as-is. If the chosen directory lives inside the repo, add it to `.gitignore` — an un-ignored `logDir` fills the working tree with untracked log files and trips the `clean-worktree` check on the next run. See the README "Configuration" section for the on-disk filename format and rotation behavior.

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
- Secret detection is git-aware and diff-scoped. A hit is a `fail` blocker only when the secret can reach the remote **and** the current change introduced it — the file is committable (tracked, or untracked-but-not-ignored) **and** the current branch changed it, measured against the merge-base with the upstream / default branch (uncommitted edits and new untracked files included). A hit in a gitignored-and-untracked file (a `.env` holding real credentials is the normal, correct state), in a `.md` documentation file, in a directory that is not a git repository, or in a tracked file the branch never touched is a non-blocking `warn`. When the merge-base cannot be resolved the check fails safe and treats every committable finding as blocking. Set `"secretDetectionStrict": true` to drop the diff-scoping and block on every committable finding. A finding is also downgraded to `warn` — regardless of diff scope or `secretDetectionStrict` — when it is an obvious test-fixture constant: the file lives under a directory literally named `test` or `tests` **and** the matched value itself starts with `test-`/`test_`/`dummy-`/`dummy_`/`fake-`/`fake_`; either condition alone still blocks (see the README's "Secret detection: obvious test-fixture values don't block" section for the exact boundary and why it's kept narrow). Keep example values in template files like `.env.example` or `.env.template`. For a measured comparison of the current regex-based engine against gitleaks and trufflehog (class coverage, false positives, runtime, license), see [`docs/secret-scanner-investigation.md`](secret-scanner-investigation.md).
- To suppress an intentional finding (a demo/example key), either list it in `secretAllowlist` in `.preflight.json` — entries are a repo-relative path, a `path:line` pair, or a `*`-glob — or put a `pragma: allowlist secret` comment on the line:

  ```json
  {
    "secretAllowlist": ["demo/playground.ts", "fixtures/*", "src/config.ts:42"],
    "secretDetectionStrict": false
  }
  ```
