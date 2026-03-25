---
name: agent-preflight-claude
description: Use this skill when Claude should run agent-preflight before completing a coding task or preparing a PR. It gives Claude-oriented guidance for invoking preflight, respecting `.preflight.json`, using the sandbox for missing dependencies, and reporting structured readiness results.
---

# Agent Preflight For Claude

Use this skill when Claude needs a deterministic final validation step before handoff.

## Install Source

- Source repository: `https://github.com/LanNguyenSi/agent-preflight`
- Template path: `templates/skills/agent-preflight-claude`
- Intended installed skill name: `agent-preflight-claude`

If an agent is installing this skill from a repo template, it should fetch it from the source repository and copy this folder into the local skills directory under `agent-preflight-claude/`.

## Claude Workflow

1. Find the repo root and read `.preflight.json` if present.
2. Run `preflight run <repo> --json`.
3. If important checks are skipped because tooling is absent, rerun with `preflight sandbox <repo> --json`.
4. Present the result as a short readiness report.

## Tool Discovery

- Prefer `preflight` if it is already available in `PATH`.
- If not, use a checked-out `agent-preflight` repository when one is available.
- Prefer `preflight sandbox <repo> --json` for sandbox reruns.
- `./agent-preflight-sandbox` remains available as a checkout-local compatibility wrapper.
- If Claude cannot find either form, it should explicitly report that `agent-preflight` is not installed or not available in the workspace.

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
