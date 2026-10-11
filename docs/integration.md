# Integrations

`agent-preflight` is one piece of a small toolchain. This page is about how it composes with the other pieces, in particular with [`agent-tasks`](https://github.com/LanNguyenSi/agent-tasks) (the task-and-PR coordinator) and with agent harnesses such as [`harness`](https://github.com/LanNguyenSi/harness).

## The claim gate alignment

`agent-tasks` lets multiple agents pick up tasks against the same repo. Each agent claims a task, branches, pushes, and only then opens a PR. That model breaks down when an agent claims a task, fails CI three times in a row, and burns the queue while it iterates remotely.

`agent-preflight` plugs into the gap. The contract is:

> Before `task_finish`, run `preflight run` against the working repo. Only call `task_finish` when `ready: true` and the confidence score clears your project's threshold.

That single rule turns "wait for CI" into "validate locally first, then push and claim done", which keeps the task queue honest:

- A claim that fails preflight never reaches `task_finish`, so no orphan PR.
- A passing preflight is structured (`blockers`, `warnings`, `limitations`, `confidence`), so the agent can quote it back into the task notes or PR body.
- The confidence score gives the merge step a deterministic gate, not just a green checkmark.

For validation that must actually run, set `requiredChecks` in `.preflight.json`, for example `["lint", "typecheck", "test"]`. Readiness then requires at least one result and all results passing for each listed kind. Disabled checks and acknowledged failures cannot satisfy the policy. Continue reporting limitations and `checks[]` entries with `status: "acknowledged"`, even when a kind is optional and the run is ready. Explicit command lists define the intended scope; the policy itself does not guarantee exhaustive stack discovery.

## Suggested wiring inside an agent loop

```bash
preflight run "$REPO_PATH" --json > /tmp/preflight.json
ready=$(jq -r '.ready' /tmp/preflight.json)
confidence=$(jq -r '.confidence' /tmp/preflight.json)

if [ "$ready" != "true" ]; then
  echo "preflight failed, fixing blockers before push"
  exit 1
fi

# threshold matches your project's risk appetite
awk "BEGIN{exit !($confidence >= 0.8)}" || {
  echo "preflight ready but confidence below 0.8, surfacing limitations"
  jq -r '.limitations[]' /tmp/preflight.json
}
```

The same JSON object can be posted into a task note or attached to a PR body so a reviewer sees what was validated and what was skipped.

## Order of operations

`agent-preflight` runs entirely locally and shares no state with the tools that open and merge the PR, but they share an order:

1. Run `preflight run` locally.
2. If ready, push the branch.
3. Open the PR with the preflight summary in the body (with agent-tasks: `pull_requests_create`).
4. CI runs the same checks remotely as the safety net.
5. Merge when CI is green and required reviewers approve (with agent-tasks: `pull_requests_merge`).

Step 1 is what `agent-preflight` adds. The remote CI in step 4 stays as the source of truth, but step 1 makes "push, wait, fix, repeat" a rare path instead of the default.

## With harness

To gate an agent on preflight under [`harness`](https://github.com/LanNguyenSi/harness), write a custom hook that runs `preflight run "$PWD" --json` and acts on `ready` or the exit code (see "With other harnesses" below). [harness's ARCHITECTURE.md](https://github.com/LanNguyenSi/harness/blob/master/docs/ARCHITECTURE.md) (§5) shows such a hook as an illustrative example. agent-preflight has no dependency on harness.

## With other harnesses

`agent-preflight` is harness-agnostic. The CLI exit code (`0` for ready, `1` otherwise) is enough for any agent runtime that can read shell exit codes. The `--json` output is enough for any runtime that can parse JSON. There is no Claude-specific or harness-specific path through the tool.

Three skill templates ship in `templates/skills/` for harnesses that prefer a structured starting point:

- [`agent-preflight`](../templates/skills/agent-preflight/SKILL.md), generic
- [`agent-preflight-opencode`](../templates/skills/agent-preflight-opencode/SKILL.md), opencode flavour
- [`agent-preflight-claude`](../templates/skills/agent-preflight-claude/SKILL.md), Claude Code flavour

They are starting points, not requirements. The CLI is the contract.
