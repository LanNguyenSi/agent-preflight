# Delivery Plan

## Execution Waves

## wave-1

Lock scope, assumptions, and engineering baseline.

- 001 Write project charter and architecture baseline
- 002 Set up repository and delivery baseline

## wave-2

Deliver the first critical capabilities and required controls.

- 003 Implement local CI simulation via act subprocess
- 004 Implement direct lint checks (ruff, eslint, tsc)

## wave-3

Expand feature coverage once the core path is in place.

- 005 Implement dependency audit (npm audit, pip audit)
- 006 Implement JSON output with confidence score and limitations
- 007 Implement repo-specific rule configuration via .preflight.json
- 008 Implement commit convention check
- 009 Implement secret detection

## wave-4

Harden, verify, and prepare the system for release.

- 010 Add integration and error-handling coverage

## Dependency Edges

- 001 -> 002
- 001 -> 003
- 002 -> 003
- 001 -> 004
- 002 -> 004
- 001 -> 005
- 002 -> 005
- 001 -> 006
- 002 -> 006
- 001 -> 007
- 002 -> 007
- 001 -> 008
- 002 -> 008
- 001 -> 009
- 002 -> 009
- 003 -> 010
- 004 -> 010
- 005 -> 010
- 006 -> 010
- 007 -> 010
- 008 -> 010
- 009 -> 010

## Critical Path

001 -> 002 -> 003 -> 010
