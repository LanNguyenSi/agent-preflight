# AI Context: agent-preflight

Read this file before changing the codebase.

## Project Overview

`agent-preflight` is a TypeScript CLI for local CI-preflight validation.

- Language: TypeScript
- CLI framework: Commander
- Distribution: Node CLI / npm package
- Config format: `.preflight.json` in the repo root; `preflight run` can instead load an explicit file via `--config <path>` or `PREFLIGHT_CONFIG` (precedence `--config` > env > repo file, no merging; relative paths resolve against the current directory; an unusable explicit file is an error, never a fallback, and any validation warning in it is fatal; the result reports `config: { source, path }`, `none` also when a broken repo file made defaults apply; the shared command runner removes the variable from commands routed through it; direct subprocesses, including built-in npm audit and `act`, currently inherit it). `batch` ignores it, `sandbox` rejects it, MCP `preflight_run` takes `configPath`. The explicit file can define shell commands like the repo file, so it must be trusted.
- Main entrypoint: `src/cli.ts`
- Secondary entrypoint: `src/mcp.ts` (MCP stdio server, `preflight-mcp` binary)

The tool runs local checks and returns a structured result with:

- `ready`
- `confidence`
- `checks`
- `blockers`
- `warnings`
- `limitations`

`checks[]` entries carry a `status` of `pass`, `fail`, `warn`, `skip`, or
`acknowledged`. `acknowledged` is a `fail` the operator explicitly waived via
`checks.<kind>.acknowledge` in `.preflight.json` (see [waiving a failing
check](docs/checks.md#waiving-a-permanently-failing-check-checkskindacknowledge)).
It adds neither an ordinary failure blocker nor a warning. If its kind is in
[`requiredChecks`](docs/checks.md#required-checks), a policy blocker names the
acknowledged result because only passing results satisfy that requirement.
Consumers must still scan `checks[]` to see every waived failure.
`secret-detection` is excluded from acknowledgement: its toggle stays a plain
`boolean`.

## Current Command Surface

- `preflight run [repoPath] [--config <path>]`
- `preflight batch [root]`
- `preflight sandbox [repoPath]`
- `preflight-mcp` (MCP stdio server; exposes `preflight_run`/`preflight_batch` — see `src/mcp.ts` and README "MCP server". The target repo's `.preflight.json` can define shell commands these tools execute, same as the CLI checks; only point it at trusted repositories.)

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
│   ├── mcp.ts        # MCP stdio server (preflight_run/preflight_batch)
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

- `logDir`
- `workingDir`
- `requiredChecks`
- `tddExceptions`
- `secretAllowlist`
- `protectedBranches`
- `actFlags`
- `secretDetectionStrict`
- `commitConvention`
- `checks`
- `setup`
- `commands`
- `sandbox`
- `customChecks`

## Working Rules

- Prefer `rg` for search.
- Use `apply_patch` for file edits.
- Do not revert unrelated user changes.
- Update `README.md` when user-facing behavior changes.
- Keep shell wrappers predictable and free of hidden side effects.
