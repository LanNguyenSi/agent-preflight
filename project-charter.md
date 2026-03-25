# Project Charter: agent-preflight

## Summary

A TypeScript CLI tool that runs CI preflight validation for AI agents. Uses act (nektos/act) as a local CI simulation engine plus direct lint and audit checks. Outputs structured JSON with pass/fail status, confidence score, and explicit limitations so agents know exactly what could not be validated locally before pushing.

## Target Users

- AI coding agents
- developers using AI-assisted workflows

## Core Features

- local CI simulation via act subprocess
- direct lint checks (ruff, eslint, tsc)
- dependency audit (npm audit, pip audit)
- JSON output with confidence score and limitations
- repo-specific rule configuration via .preflight.json
- commit convention check
- secret detection

## Constraints

- TypeScript CLI, no web framework needed
- act must be installed separately as a peer dependency
- must work offline for direct checks
- JSON output format is a stable API contract for agent consumption
- no database required
- single deployable CLI binary

## Non-Functional Requirements

- fast local execution (direct checks < 5s)
- clear confidence scoring (0.0-1.0)
- explicit limitations output so agents know what was not checked

## Delivery Context

- Planner profile: product
- Intake completeness: complete
- Phase: phase_1
- Path: core
- Data sensitivity: low

## Applicable Playbooks

- /root/.openclaw/workspace/git/agent-planforge/playbooks/planning-and-scoping.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/01-project-setup.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/02-architecture.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/03-team-roles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/04-design-principles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/05-development-workflow.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/06-testing-strategy.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/07-quality-assurance.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/08-documentation.md

## Missing Information

- None

## Follow-Up Questions

- None

## Open Questions

- None
