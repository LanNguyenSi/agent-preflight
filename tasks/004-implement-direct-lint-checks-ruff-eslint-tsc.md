# Task 004: Implement direct lint checks (ruff, eslint, tsc)

## Category

feature

## Priority

P1

## Wave

wave-2

## Delivery Phase

core-checks

## Depends On

- 002

## Blocks

- 010

## Summary

Implement `src/checks/lint.ts` and `src/checks/typecheck.ts` — auto-detect the repo's language/framework and run appropriate linters directly (not via act).

## Problem

CI lint failures are the most common cause of failed pipelines. Running linters directly (without Docker/act) is fast (<5s) and catches the majority of issues.

## Solution

**lint.ts:**
- Detect TypeScript/JS project (package.json with eslint) → run `npx eslint`
- Detect Python project (pyproject.toml / setup.py) → run `ruff check` if installed
- Return limitation if no linter found

**typecheck.ts:**
- Detect tsconfig.json → run `npx tsc --noEmit --skipLibCheck`
- Return limitation if no tsconfig found

## Files To Create Or Modify

- `src/checks/lint.ts` — eslint + ruff detection and execution (implemented ✅)
- `src/checks/typecheck.ts` — tsc execution (implemented ✅)

## Acceptance Criteria

- [ ] Detects eslint from package.json devDependencies
- [ ] Detects ruff via `which ruff`
- [ ] Returns limitation message when no linter available
- [ ] TypeScript check uses --skipLibCheck for speed
- [ ] Each check has confidenceContribution assigned

## Implementation Notes

Status: **DONE** ✅ — see `src/checks/lint.ts` and `src/checks/typecheck.ts`
