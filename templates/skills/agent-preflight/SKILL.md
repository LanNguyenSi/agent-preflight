---
name: agent-preflight
description: Use this skill when an agent should validate a repository with agent-preflight before push, PR, handoff, or final status reporting. It covers local preflight execution, JSON result parsing, when to use workingDir and commands overrides, and when to rerun in the sandbox if host tooling is incomplete.
---

# Agent Preflight

Use this skill when the task includes "check before push", "validate locally", "run preflight", "summarize readiness", or equivalent agent handoff gates.

## Workflow

1. Resolve the repo root and inspect `.preflight.json` when present.
2. If the repo is a monorepo or the relevant code lives below the root, set or honor `workingDir`.
3. Run `preflight run <repo> --json`.
4. If the result mainly contains missing-tool limitations, consider rerunning with `./agent-preflight-sandbox`.
5. Report:
   - blockers
   - warnings
   - limitations
   - confidence
   - whether the repo is ready

## Output Rules

- Treat `ready` as the release gate.
- Treat `confidence` as a secondary signal, not the gate.
- Quote blockers and warnings from the structured result, not from intuition.
- Mention when checks were skipped because tooling was absent.
- If you rerun in the sandbox, say so explicitly.

## When To Read More

- For `.preflight.json` patterns and stack-specific command overrides, read [references/config-patterns.md](references/config-patterns.md).
- For deciding between host execution and sandbox execution, read [references/runtime-decision.md](references/runtime-decision.md).

## Do Not

- Do not say a repo is ready without actually running `preflight`.
- Do not hide limitations such as skipped `act`, missing `phpstan`, or missing `mypy`.
- Do not invent stack-specific commands if the repo already provides overrides in `.preflight.json`.
