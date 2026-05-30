# Solution-acceptance gate

Verifier-gated "done": make completion **earned from real check results**, not
**claimed** by the agent doing the work.

## The problem it addresses

An agent that solved a task is the worst judge of whether it solved it. Asked
"are you done?", a model will often answer yes against its own narration:
"tests pass" (it ran a mocked subset), "build is green" (it never ran it),
"the fix is complete" (an edge case is open). The failure is structural, not a
prompting bug, so it cannot be prompted away. It has to be constructed away:
the signal that flips a task to done must come from somewhere the solving agent
cannot author.

This gate derives a **verdict** from a real `preflight` run (the same lint /
typecheck / test / audit / secret battery the rest of this tool runs), pins it
to the exact git HEAD it was produced at, and writes it to a producer-owned
marker. A separate **gate** check then passes only when a ready verdict exists
at the *current* HEAD.

## Mechanism

Two commands:

```bash
preflight verdict <id> [repoPath]   # producer: run checks, record the verdict
preflight gate    <id> [repoPath]   # consumer: pass only on a ready verdict at HEAD
```

- `verdict` runs `preflight` against the repo, captures `ready` (no blockers),
  `confidence`, and the blocker list, and records a marker
  `{ id, head, ready, confidence, blockers, timestamp, preflightVersion }`.
  `head` is the current `git rev-parse HEAD`. Exit 0 when ready, 1 otherwise.
- `gate` reads the marker for `<id>`, resolves the current HEAD, and exits:
  - `0` (PASS) only if a marker exists **and** `ready` **and**
    `marker.head === current HEAD`;
  - `2` (DENY) otherwise, with a precise reason: no verdict recorded, verdict
    not ready (with the blockers), HEAD drift (recorded vs current sha), or an
    unresolvable HEAD.

Markers live in a producer-owned directory outside the repo working tree:
`$PREFLIGHT_VERDICT_DIR` if set (used by tests), else
`$XDG_STATE_HOME/agent-preflight/verdicts`, else
`~/.local/state/agent-preflight/verdicts`. The `<id>` is reduced to a single
safe path segment before use, so it can never escape that directory.

## Anti-hacking contract

The point of the gate is that an agent cannot satisfy it by asserting success.
Four properties hold in this v1:

1. **Derived, not claimed.** `ready` comes from the real `preflight` run, never
   from a caller-supplied flag.
2. **Producer is not the solver.** Only `preflight verdict` writes the marker,
   and the check set is taken from the committed `.preflight.json`, not from CLI
   arguments. An agent cannot pass `--no-test` (or similar) to weaken the gate
   at call time; to change what is checked it must change committed config,
   which is reviewable.
3. **HEAD-pinned.** A verdict counts only at the exact HEAD it was produced at.
   Any further edit shifts HEAD and invalidates a green verdict. This is the
   brake on the most common reward-hack: "claim done, then keep changing
   things". It mirrors the `at_head` rule in the `harness` requires-evaluator.
4. **No stale green.** A re-run that finds blockers overwrites a prior green
   marker with red, so a passing verdict cannot linger after a regression.

## Documented residuals (tracked as follow-ups)

This is the deterministic floor, deliberately the smallest honest slice. Known
gaps, each a follow-up rather than a hidden assumption:

- **Marker forgeability.** A shell-capable agent could hand-write the marker
  file. Closing this means signing the verdict, or moving the signal into a
  harness-owned marker directory checked by a `PreToolUse` hook the agent's
  tools cannot write to (the pattern `harness`'s understanding-gate already uses
  via `checkApprovalMarker`). That harness wiring is the immediate next step:
  this command pair is the producer half it consumes.
- **Goodhart on tests.** A green exit code is necessary, not sufficient: the
  cheapest hack is "green by deleting the failing test". A future verdict should
  carry the test-count delta against the base ref and flag removed or skipped
  tests in the diff.
- **Floor only, no judgement.** The verdict is a pass/fail floor from
  deterministic checks. An LLM-judge layer (calibrated against ground-truth
  cases) sits on top later, and relative ranking ("best of N solutions", not
  just "acceptable") is a separate problem.

## Relationship to harness and agent-grounding

`harness` is the hook-wiring layer that fires checks and gates tool calls on a
freshness-windowed, optionally HEAD-pinned signal. This gate gives it a
solution-quality signal to consume, distinct from the process-maturity signal
the claim-gate already produces. The design originates in agent-grounding's
"solution-acceptance gate" task; this package implements the producer.
