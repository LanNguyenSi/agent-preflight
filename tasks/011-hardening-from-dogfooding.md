# Task 011: Hardening from Dogfooding (Round 1)

## Category

hardening

## Priority

P1

## Wave

wave-5

## Delivery Phase

hardening

## Depends On

- 010

## Blocks

none

## Summary

Fix issues found during live dogfooding of agent-preflight against our own repos (2026-03-25). Several real problems surfaced that reduce tool accuracy and confidence scores.

## Dogfooding Results

Tested against 8 repos. Findings:

| Repo | Ready | Confidence | Issues |
|------|-------|------------|--------|
| allergen-guard | ✅ | 81% | commit convention warnings |
| plagiarism-coach | ✅ | 91% | clean |
| agent-preflight | ✅ | 71% | npm-audit warning |
| frost-core | ❌ | 61% | npm-audit, no eslint |
| frost-dashboard | ❌ | 63% | npm-audit, commit convention |
| github-api-tool | ❌ | 52% | no eslint, commit convention (5 lims) |
| memory-weaver | ❌ | 32% | TypeScript type errors, npm-audit |
| triologue | ❌ | 58% | potential secrets, commit convention |

## Problems Found

### Problem 1: No eslint → Lint check silently skipped

**Repos affected:** frost-core, github-api-tool (monorepo), triologue

**Root cause:** Lint check only runs if `eslint` is in `package.json` devDependencies. Repos without eslint get a limitation instead of a useful check.

**Fix:** Also run `npx tsc --noEmit` as fallback lint signal when no eslint is configured (already done for typecheck but not counted toward lint confidence).

### Problem 2: confidence too low without eslint (github-api-tool: 52%)

**Root cause:** github-api-tool is a monorepo with `cli/` subdir. Checks run at root level, find nothing, add many limitations.

**Fix:** Detect monorepo structure (package.json in subdirectory) and run checks in the right directory. Config: `workingDir: "cli/"` in `.preflight.json`.

### Problem 3: triologue secret detection false positive (?)

**Root cause:** `src/checks/secrets.ts` pattern-matched something in triologue as a potential secret. Likely a test fixture or config example.

**Fix:** Investigate the actual match. Add allowlist support in `.preflight.json`:
```json
{ "secretDetection": { "ignoreFiles": ["src/__tests__/**", "*.example.*"] } }
```

### Problem 4: memory-weaver TypeScript type errors

**Root cause:** `src/memory/v2/IdentityCore.ts` has real type errors (mkdtempSync issue we saw in CI before). This is a real blocker — agent-preflight correctly catches it.

**Action:** Fix the TypeScript errors in memory-weaver (separate task). agent-preflight behavior is correct.

### Problem 5: Commit convention warnings on most repos

**Root cause:** Many of our recent commits (e.g. "fix: upgrade @fastify/cors to v11") include the reviewed-by suffix `(Ice 🧊)` which breaks the 80-char limit in the regex pattern.

**Fix:** Relax the commit message regex to allow longer messages with parenthetical author attribution:
```
/^(feat|fix|docs|...): .{1,}/  // remove 80-char limit
```

### Problem 6: ready: false even with only warnings (not blockers)

**Root cause:** `ready` is `false` when `confidence < 0.7`, not just when there are blockers. frost-core and frost-dashboard have only warnings but are marked NOT READY.

**Fix:** Separate "ready" from "confidence". A repo can be `ready: true` with low confidence (warnings only) vs `ready: false` (has blockers). Current: `ready = blockers.length === 0 && confidence >= 0.7`. Proposed: `ready = blockers.length === 0`.

## Acceptance Criteria

- [ ] github-api-tool confidence ≥ 70% with monorepo workingDir config
- [ ] frost-core and frost-dashboard marked ready: true (warnings only, no blockers)
- [ ] commit convention check allows longer messages with attribution
- [ ] triologue: investigate + document secret finding (false positive or real)
- [ ] `workingDir` config option supported in `.preflight.json`
- [ ] Secret detection allowlist patterns supported

## Files To Create Or Modify

- `src/runner.ts` — fix ready flag logic (blockers only, not confidence)
- `src/checks/commits.ts` — relax 80-char commit message limit
- `src/checks/secrets.ts` — add ignoreFiles/ignorePatterns support
- `src/config.ts` — add workingDir + secretDetection config options
- `src/types.ts` — extend PreflightConfig with new options
- `tests/` — update tests for new behavior
