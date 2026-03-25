# ADR-002: Primary Data Store

## Context

Project: agent-preflight

Summary: A TypeScript CLI tool that runs CI preflight validation for AI agents. Uses act (nektos/act) as a local CI simulation engine plus direct lint and audit checks. Outputs structured JSON with pass/fail status, confidence score, and explicit limitations so agents know exactly what could not be validated locally before pushing.

## Decision

Use a relational primary data store unless the domain clearly requires a different model.

## Consequences

### Positive

- Faster alignment on a high-leverage decision.
- Better reviewability for future changes.

### Negative

- This decision may need revision as requirements sharpen.

### Follow-Up

- Validate this ADR during the first implementation wave.
- Update if significant scope or risk assumptions change.
