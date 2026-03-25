---
name: agent-preflight-opencode
description: Use this skill when OpenCode should run agent-preflight as a final validation step. It gives OpenCode-specific instructions for running `preflight --json`, escalating to agent-preflight-sandbox when tooling is missing, and summarizing blockers, warnings, limitations, and confidence in a concise handoff.
---

# Agent Preflight For OpenCode

Use this skill when OpenCode is about to finish coding work, open a PR, or hand off results.

## OpenCode Workflow

1. Inspect `.preflight.json` if present.
2. Run `preflight run <repo> --json`.
3. If output shows missing tooling, rerun with `./agent-preflight-sandbox`.
4. Summarize the result in the final answer with:
   - `ready`
   - blockers
   - warnings
   - limitations
   - confidence

## OpenCode-Specific Guidance

- Prefer short, factual summaries.
- Mention exact commands you ran.
- If sandbox mode was required, say which limitation triggered the fallback.
- If `ciSimulation` was requested, mention whether the run used `--docker-socket`.

## When To Read More

- For stack-specific config examples, read [references/config-patterns.md](references/config-patterns.md).
- For host-vs-sandbox decision rules, read [references/runtime-decision.md](references/runtime-decision.md).
