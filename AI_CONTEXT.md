# AI Context: agent-preflight

Read this file before changing the codebase.

## Project Overview

`agent-preflight` is a TypeScript CLI for local CI-preflight validation.

- Language: TypeScript
- CLI framework: Commander
- Distribution: Node CLI / npm package
- Config format: `.preflight.json` in the repo root
- Main entrypoint: `src/cli.ts`

The tool runs local checks and returns a structured result with:

- `ready`
- `confidence`
- `checks`
- `blockers`
- `warnings`
- `limitations`

## Current Command Surface

- `preflight run [repoPath]`
- `preflight batch [root]`
- `preflight sandbox [repoPath]`

The optional legacy Docker wrapper is `./agent-preflight-sandbox`.
`preflight sandbox` resolves a capability-based local image profile from the target repo and may auto-build a matching image on first use.
`install.sh` supports both a source checkout and a prebuilt release bundle.

## Repository Structure

```text
agent-preflight/
├── src/
│   ├── checks/       # Individual check runners
│   ├── batch.ts      # Batch-mode orchestration
│   ├── cli.ts        # Commander CLI
│   ├── config.ts     # .preflight.json loading + defaults
│   ├── runner.ts     # Main preflight orchestration
│   └── types.ts      # Shared types
├── tests/            # Vitest suites
├── Dockerfile        # Optional sandbox runtime
├── agent-preflight-sandbox
├── install.sh
├── scripts/          # Packaging helpers such as the release bundle builder
├── README.md
└── Makefile
```

## Architecture Notes

- Checks are modular and return `checks[]` plus `limitations[]`.
- `runner.ts` is the only place that computes `ready` and `confidence`.
- Direct checks should degrade gracefully into limitations when tooling is absent.
- `ready` means no blockers. Low confidence alone must not make a repo not ready.

## Adding Or Changing Checks

When adding a check:

1. Keep the runner contract stable.
2. Prefer manifest detection plus sensible defaults.
3. Allow repo-specific overrides through `.preflight.json`.
4. Keep sandbox profile detection conservative and extend it via config when inference would be risky.
5. Return explicit limitations instead of throwing when a tool is missing.
6. Add or update Vitest coverage for the new behavior.

Supported override areas in config:

- `workingDir`
- `checks`
- `commands`
- `sandbox`
- `customChecks`
- `actFlags`

## Working Rules

- Prefer `rg` for search.
- Use `apply_patch` for file edits.
- Do not revert unrelated user changes.
- Update `README.md` when user-facing behavior changes.
- Keep shell wrappers predictable and free of hidden side effects.
