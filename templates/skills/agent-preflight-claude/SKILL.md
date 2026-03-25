---
name: agent-preflight-claude
description: Use this skill when Claude should run agent-preflight before completing a coding task or preparing a PR. It gives Claude-oriented guidance for invoking preflight, respecting `.preflight.json`, using the sandbox for missing dependencies, and reporting structured readiness results.
---

# Agent Preflight For Claude

Use this skill when Claude needs a deterministic final validation step before handoff.

## Claude Workflow

1. Find the repo root and read `.preflight.json` if present.
2. Run `preflight run <repo> --json`.
3. If important checks are skipped because tooling is absent, rerun in `agent-preflight-sandbox`.
4. Present the result as a short readiness report.

## Reporting Format

Claude should summarize:

- `ready`
- primary blockers
- notable warnings
- explicit limitations
- confidence

If a rerun changed the outcome, Claude should mention both runs and why the second run was used.

## When To Read More

- For config examples by stack, read [references/config-patterns.md](references/config-patterns.md).
- For runtime selection, read [references/runtime-decision.md](references/runtime-decision.md).
