---
name: agent-preflight
description: Use this skill when an agent should validate a repository with agent-preflight before push, PR, handoff, or final status reporting. It covers local preflight execution, JSON result parsing, when to use workingDir and commands overrides, and when to rerun in the sandbox if host tooling is incomplete.
---

# Agent Preflight

Use this skill when the task includes "check before push", "validate locally", "run preflight", "summarize readiness", or equivalent agent handoff gates.

## Install Source

- Source repository: `https://github.com/LanNguyenSi/agent-preflight`
- Template path: `templates/skills/agent-preflight`
- Intended installed skill name: `agent-preflight`

If an agent is installing this skill from a repo template, it should fetch it from the source repository and copy this folder into the local skills directory under `agent-preflight/`.

## Workflow

1. Resolve the repo root and inspect `.preflight.json` when present.
2. If the repo is a monorepo or the relevant code lives below the root, set or honor `workingDir`. Honor configured command objects and `requiredChecks`; each required kind needs at least one result and every result passing.
3. Run `preflight run <repo> --json`.
4. If the result mainly contains missing-tool limitations, consider rerunning with `preflight sandbox <repo> --json`.
5. Scan `checks[]` for `status: "acknowledged"`: a waived failure keeps its status and reason. It is non-blocking by default, but cannot satisfy `requiredChecks`; the unmet policy then appears in `blockers[]`. Report waived failures even when the run is ready.
6. Report:
   - blockers
   - warnings
   - acknowledged checks (name + reason, from `checks[]`), if any
   - limitations
   - confidence
   - whether the repo is ready

## Tool Discovery

- Prefer `preflight` when it is already available in `PATH`.
- If `preflight` is not installed globally, use a checked-out `agent-preflight` repository when one is available.
- Prefer `preflight sandbox <repo> --json` for sandbox reruns.
- `./agent-preflight-sandbox` remains available as a checkout-local compatibility wrapper.
- If neither a binary nor a checkout is available, say that `agent-preflight` must be installed or made available before you can run the validation.

## Output Rules

- Treat `ready` as the release gate.
- Treat `confidence` as a secondary signal, not the gate.
- Quote blockers and warnings from the structured result, not from intuition.
- Quote acknowledged checks too: scan `checks[]` for `status: "acknowledged"` and name them alongside blockers/warnings — `ready: true` with a waived failure still deserves visibility, since the caller decided to accept it, not that nothing happened.
- Mention when checks were skipped because tooling was absent. Required checks evaluate returned results; continue reporting limitations and do not infer exhaustive stack coverage.
- If you rerun in the sandbox, say so explicitly.

## When To Read More

- For `.preflight.json` patterns and stack-specific command overrides, read [references/config-patterns.md](references/config-patterns.md).
- For deciding between host execution and sandbox execution, read [references/runtime-decision.md](references/runtime-decision.md).

## Do Not

- Do not say a repo is ready without actually running `preflight`.
- Do not hide limitations such as skipped `act`, missing `phpstan`, or missing `mypy`.
- Do not invent stack-specific commands if the repo already provides overrides in `.preflight.json`.
- Do not report READY based on `blockers`/`warnings` alone — also check `checks[]` for `status: "acknowledged"` entries and surface them; they are waived failures, not passes.
