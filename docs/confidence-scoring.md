# Confidence scoring

`agent-preflight` returns a confidence score between 0 and 1 alongside the boolean `ready` flag. The score tells an agent how much of the pipeline was actually validated locally, not just whether nothing failed.

## Why a score, not just pass or fail

A green "no blockers" result is misleading when half the checks were skipped because tools were missing or the stack was unknown. The score makes that gap explicit:

- `ready: true` means there are no blocking failures.
- `confidence: 0.49` means only half the validation surface was exercised.

An agent can read both signals and decide whether to push, ask a human, or run more checks (for example with `--ci-simulation`).

## Scoring model

Each check declares a weight via `confidenceContribution`. Weights are added up, and only the weights of checks with `status: "pass"` count toward the score. Then the runner deducts a small penalty for each `limitation` recorded during the run, capped at 0.2.

```
base       = sum(weights of passed checks) / sum(weights of all run checks)
penalty    = min(limitations.length * 0.03, 0.2)
confidence = max(0, min(1, base - penalty))
```

If no checks run, the score is 0.

## Default weights

| Check | Weight |
|-------|-------:|
| Lint | 0.15 |
| Typecheck | 0.15 |
| Test | 0.15 |
| Dependency audit | 0.15 |
| CI simulation (per workflow result) | 0.25 |
| Secret detection | 0.10 |
| TDD signal (warn or pass) | 0.05 to 0.10 |
| Git state, clean worktree | 0.05 |
| Git state, protected branch | 0.05 |
| Commit convention | 0.05 |

CI simulation carries the highest single weight because running the actual workflow with `act` validates more of the pipeline than any individual check.

## Why deterministic, not LLM-scored

The score is a weighted ratio of deterministic check outcomes. There is no model in the loop, no temperature, no prompt drift. Two runs of the same repo with the same tools and config produce the same score, which makes it usable as a gate in automated workflows. An LLM-derived confidence would be cheaper to compute on novel stacks but worse to rely on, so the project leans on declared weights and a fixed penalty.

## Limitations are first-class

Every skipped or partially executed check appends a string to `result.limitations`. Examples:

```
~ No supported linter found; lint check skipped
~ No supported typecheck command found; typecheck skipped
~ secret detection uses pattern matching; not exhaustive
~ CI simulation skipped (enable with checks.ciSimulation: true, requires act)
```

Limitations are reported back to the caller so an agent can quote them when explaining why it did or did not push. They also penalise the score, so a run with many skips reads as low confidence even when nothing technically failed.

## Reading the result

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

A typical agent-friendly heuristic:

- `ready && confidence >= 0.8`, push.
- `ready && confidence < 0.6`, surface limitations to the user before pushing.
- `!ready`, never push, fix blockers first.

Pick the thresholds that match your team's risk appetite. The weights and the penalty cap are stable across runs, so any threshold you set today will mean the same thing tomorrow.
