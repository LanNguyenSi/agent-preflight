---
name: agent-preflight-opencode
description: Use this skill when OpenCode should run agent-preflight as a final validation step. It gives OpenCode-specific instructions for running `preflight --json`, escalating to `preflight sandbox` when tooling is missing, and summarizing blockers, warnings, limitations, and confidence in a concise handoff.
---

# Agent Preflight For OpenCode

Use this skill when OpenCode is about to finish coding work, open a PR, or hand off results.

## Install Source

- Source repository: `https://github.com/LanNguyenSi/agent-preflight`
- Template path: `templates/skills/agent-preflight-opencode`
- Intended installed skill name: `agent-preflight-opencode`

If an agent is installing this skill from a repo template, it should fetch it from the source repository and copy this folder into the local skills directory under `agent-preflight-opencode/`.

## OpenCode Workflow

1. Inspect `.preflight.json` if present.
2. Run `preflight run <repo> --json`.
3. If output shows missing tooling, rerun with `preflight sandbox <repo> --json`.
4. Summarize the result in the final answer with:
   - `ready`
   - blockers
   - warnings
   - limitations
   - confidence

## Tool Discovery

- Prefer `preflight` from `PATH`.
- If the binary is not installed, use a checked-out `agent-preflight` repo when one is available in the workspace.
- Prefer `preflight sandbox <repo> --json` for sandbox reruns.
- `./agent-preflight-sandbox` remains available as a checkout-local compatibility wrapper.
- If OpenCode cannot find either the binary or a checkout, it should report that `agent-preflight` is unavailable instead of pretending validation succeeded.

## OpenCode-Specific Guidance

- Prefer short, factual summaries.
- Mention exact commands you ran.
- If sandbox mode was required, say which limitation triggered the fallback.
- If `ciSimulation` was requested, mention whether the run used `--docker-socket`.

## When To Read More

- For stack-specific config examples, read [references/config-patterns.md](references/config-patterns.md).
- For host-vs-sandbox decision rules, read [references/runtime-decision.md](references/runtime-decision.md).
