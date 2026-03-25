# Improve agent-preflight

## Context

`agent-preflight` is a TypeScript CLI tool for pre-push CI validation of code repositories. It runs hybrid checks (lint, typecheck, tests, audit, secrets, commits, CI simulation) and returns structured JSON with a confidence score and limitations list.

Repository: https://github.com/LanNguyenSi/agent-preflight  
Current version: working, battle-tested (70% of repos pass in dogfooding)

## Open Issues (from Task 011)

### 1. Monorepo / workingDir auto-detection

**Problem:** `github-api-tool` is a monorepo where the actual code lives in `cli/`. Running checks at the root finds no `package.json` → all checks skipped → low confidence (52%).

**Expected behavior:** If `package.json` is missing at root but exists in a subdirectory, detect the most likely working directory and either auto-use it or add a limitation suggesting `workingDir` config.

**File:** `src/checks/shared.ts` (`createProjectContext`) and `src/runner.ts` (`resolveTargetPath`)

**Acceptance criteria:**
- `preflight run ./github-api-tool` → confidence ≥ 70%  
- Or clear limitation: "package.json found in cli/ — set workingDir: cli/ in .preflight.json"

---

### 2. Lint fallback when no linter configured

**Problem:** Repos without eslint or ruff get a limitation but no actual lint check runs. A TypeScript repo without eslint could still be typechecked more aggressively as a lint signal.

**Expected behavior:** When no linter is found but `tsconfig.json` exists, count the typecheck result toward lint confidence too (not as an extra limitation).

**File:** `src/checks/lint.ts`

---

### 3. composer install not automatic in sandbox

**Problem:** PHP/Symfony repos need `composer install` (vendor/ directory) before any PHP checks work. The sandbox image has composer but doesn't run install automatically.

**Expected behavior:** If a `composer.json` exists and `vendor/` does not, run `composer install --no-interaction` as a setup step before PHP checks.

**File:** `src/checks/shared.ts` (add setup step before PHP checks)

**Acceptance criteria:**
- `docker run --rm -v /path/to/symfony-project:/workspace agent-preflight:local run /workspace` → PHP checks actually run

---

### 4. gitignore-aware secret scanning

**Problem:** The secret scanner finds secrets in files that are tracked by `.gitignore` (e.g. `.env` — currently excluded by filename but not by gitignore rules). Some repos have unusual `.env` filenames or configs.

**Expected behavior:** Parse `.gitignore` and skip all gitignore-matched files during secret scanning.

**File:** `src/checks/secrets.ts`

**Note:** Low priority — current filename-based exclusion handles 90% of cases.

---

## Architecture Notes

- `src/checks/shared.ts` — shared infrastructure (ProjectContext, runCommand, commandExists, stack detection)
- `src/runner.ts` — orchestrates all checks, resolves workingDir
- `src/config.ts` — loads `.preflight.json`
- `src/types.ts` — PreflightConfig, CheckResult, PreflightResult

## Testing

```bash
make setup   # install + build
make test    # run 40 tests
make run     # preflight run on current repo
```

When adding a feature, add tests to `tests/`. The existing test structure:
- `tests/runner.test.ts` — unit tests
- `tests/batch.test.ts` — batch command
- `tests/commits.test.ts` — commit convention
- `tests/integration/` — integration tests (use real temp repos)
- `tests/contract/` — JSON output contract tests (stable API for agents)
- `tests/profiles.test.ts` — stack profiles

## Stack / Linting

TypeScript, Commander, Execa. No eslint config yet (ironic). Vitest for tests.

Build: `npm run build` (tsc)  
Type check: `npx tsc --noEmit --skipLibCheck`

## Success Criteria

After implementing improvements:
- `preflight run ./github-api-tool` → confidence ≥ 70%
- `preflight run ./notification-service` (PHP/Symfony, composer installed) → PHP checks run
- All 40 existing tests still pass
- No new test failures introduced
