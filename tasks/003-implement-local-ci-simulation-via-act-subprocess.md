# Task 003: Implement local CI simulation via act subprocess

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

Implement `src/checks/ci.ts` — wraps the `act` CLI (nektos/act) to run a dry-run of local GitHub Actions workflows and return a structured `CheckResult`.

## Problem

Agents push code and wait for GitHub CI to validate it. This is slow and creates a blind-push cycle. act can simulate CI locally, but raw act output is not agent-friendly.

## Solution

Call `act --dry-run --json` as a subprocess. Parse exit code and output. Return a `CheckResult` with:
- `status: "pass" | "fail" | "skip"` (skip when act not installed)
- `confidenceContribution: 0.25` (highest weight — closest to real CI)
- explicit `limitations` noting where local simulation diverges from GitHub

## Files To Create Or Modify

- `src/checks/ci.ts` — act subprocess wrapper (implemented ✅)
- `src/types.ts` — CheckResult, CheckKind types (implemented ✅)

## Acceptance Criteria

- [ ] Returns `skip` with limitation message when act is not installed
- [ ] Returns `pass` when act dry-run exits 0
- [ ] Returns `fail` with details when act dry-run exits non-zero
- [ ] Timeout after 120s to avoid hanging
- [ ] Respects `actFlags` from `.preflight.json` config

## Implementation Notes

Status: **DONE** ✅ — see `src/checks/ci.ts`
