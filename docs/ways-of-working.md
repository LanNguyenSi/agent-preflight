# Ways of Working: agent-preflight

## Definition of Done

A command, feature, or bug fix is done when:

- [ ] Code compiles / passes linting with no new warnings
- [ ] Tests are written and passing (unit-tests strategy - see below)
- [ ] Exit codes are correct for success and failure paths
- [ ] Help text is accurate and complete (`--help` for the affected command)
- [ ] Error messages follow the project's message format (see Error Messages)
- [ ] Documentation is updated if a public interface changed
- [ ] Code has been reviewed by at least one other contributor
- [ ] Change has been manually tested against a real terminal (not just unit tests)
- [ ] Config changes are backward compatible, or migration is documented

## CLI UX Conventions

These rules govern how the tool behaves from a user perspective. All contributors must follow them.

### Exit Codes

Use the canonical exit codes documented in [docs/architecture.md](architecture.md#exit-codes).

- Exit `0` when the run is ready (no blocking failures), even if every check was skipped
- Exit `1` when the run is not ready (`run`), or when any repo is not ready (`batch`)
- Usage errors (unknown flags or commands) are handled by `commander`, which prints to stderr and exits non-zero; the tool does not define a separate usage-error code
- Drive the exit from the top-level handler in `cli.ts` (`process.exit(result.ready ? 0 : 1)`); do not scatter `process.exit()` calls through the check modules

### stdout vs stderr

| Stream | What goes here |
|--------|----------------|
| `stdout` | All program output meant for the user or downstream tools |
| `stderr` | Warnings, progress messages, debug logs, error messages |

This makes the tool composable:

```bash
preflight run . --json | jq '.checks[]'
```

### Error Messages

Errors written to stderr must follow this format:

```
error: <what went wrong>. <how to fix it>.
```

Examples:

```
error: unknown option '--output'. Run 'preflight run --help' to see the available flags.
error: could not parse .preflight.json: unexpected token at line 4. Fix the JSON and re-run.
error: target path '/tmp/missing-repo' does not exist. Pass a path to an existing repository.
```

Never expose raw exception traces to the user by default.

### Structured Output

`run`, `batch`, and `sandbox` accept a single `--json` flag that prints the raw result object (the `PreflightResult`, or the batch summary) as pretty-printed JSON on stdout; without it they print a human-readable summary. There is no `--output` / `-o` selector and no `text` or `yaml` variants. The `--json` schema (`ready`, `confidence`, `checks`, `blockers`, `warnings`, `limitations`, `durationMs`, `timestamp`) must remain stable across releases.

## Planned / not yet implemented

The conventions below are aspirational. The current `commander`-based CLI implements only `--json`, `--setup`, `--ci-simulation`, `--no-audit`, and `--no-secrets` (plus `--only` / `--exclude` on `batch` and the image flags on `sandbox`). None of the flags or behaviors in this section exist yet; treat them as the target shape if and when the surface grows, not as current behavior.

### Color Output

- Use color to aid readability, not to convey meaning alone (accessibility)
- Respect `NO_COLOR=1` (see [no-color.org](https://no-color.org)) and a `--no-color` flag
- Disable color automatically when stdout/stderr is not a TTY (i.e., when piped)
- Suggested palette: red for errors, yellow for warnings, green for success, cyan for labels

### Progress Indicators

For operations that may take more than one second:

- Show a spinner or progress bar on stderr
- Clear the progress indicator before printing final output to stdout
- Disable progress indicators when not a TTY (or behind a `--quiet` flag)
- Never mix progress output into stdout

### --dry-run

If a state-mutating command is ever added, it should support `--dry-run`:

- Print what would happen, prefixed with `[dry-run]` on stderr
- Exit `0` without making any changes
- Output must be human-readable; not required to be machine-parseable in dry-run mode

### Interactive vs Non-interactive

- The tool must function fully in non-interactive mode (no TTY, no stdin); it already does
- Never prompt for input unless stdin is a TTY and no flag was provided
- Any future prompt must have a flag equivalent for scripting

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: breaking change to CLI interface (removed flag, changed exit code, changed output schema)
- **MINOR**: new subcommand, new option, new output field (backward compatible)
- **PATCH**: bug fix, documentation fix, internal refactor with no interface change

### What Counts as a Breaking Change

- Removing or renaming a command or flag
- Changing the meaning of an exit code
- Changing the JSON output schema in a way that removes or renames fields
- Changing a flag from optional to required

### What Does NOT Count as a Breaking Change

- Adding a new optional flag
- Adding new fields to JSON output
- Changing help text wording
- Improving error messages

## Release Process

1. Bump version in `package.json`
2. Update `CHANGELOG.md`
3. Commit: `chore(release): v1.2.3`
4. Tag: `git tag v1.2.3`
5. Push tag: `git push origin v1.2.3`
6. CI builds and publishes the release bundle assets automatically

## Branching Strategy

Trunk-based development with short-lived feature branches.

### Branch Naming

```
feature/<ticket>-<short-description>
fix/<ticket>-<short-description>
chore/<description>
docs/<description>
```

### Workflow

1. Branch from `main`
2. Make small, focused commits
3. Open a Pull Request (draft if in progress)
4. Pass CI checks
5. Get at least one review approval
6. Squash-merge into `main`
7. Delete the branch

## Pull Request Conventions

### PR Title

Use conventional commit format:

```
feat(run): add --format flag for structured output
fix(config): handle missing config dir gracefully
docs(architecture): document exit code table
chore(deps): update commander to latest
```

### PR Description

Include:

- **What**: what changed
- **Why**: motivation or ticket reference
- **Testing**: how you verified it (command invocations, test names)
- **UX impact**: any change to output, flags, or exit codes

## Testing Expectations

Strategy: **unit-tests** with [Vitest](https://vitest.dev/).

### Unit Test Rules

- Tests live as flat `*.test.ts` files in `tests/` (e.g. `tests/runner.test.ts`, `tests/secrets.test.ts`, `tests/git-state.test.ts`), with `tests/integration/` and `tests/contract/` for cross-module and contract suites. There are no `tests/commands/` or `tests/config/` directories; the config loader is the single file `src/config.ts`, exercised by `tests/runner.test.ts` and the integration suites.
- Use Vitest `describe` / `it` blocks with descriptive names.
- Tests must not touch the filesystem except through temp directories (`fs.mkdtempSync(path.join(os.tmpdir(), ...))`).
- Tests must not make network calls.
- Tests must not depend on environment variables unless explicitly set in the test.
- Run the suite with `npm test` (`vitest run`); collect coverage with `npx vitest run --coverage` (provided by `@vitest/coverage-v8`). Aim for branch coverage of the check runners (`src/checks/`) and `runner.ts`; there is no enforced threshold gate.

### Test Naming

Name `describe` blocks after the unit under test and `it` blocks after the scenario and expected outcome:

```ts
describe("runPreflight", () => {
  it("marks the repo not ready when a check fails", () => { /* ... */ });
  it("reports confidence 0 when no checks run", () => { /* ... */ });
});
```

## Architecture Decision Records (ADRs)

Write an ADR in `docs/adrs/` when:

- Choosing a library or external dependency
- Changing the output schema of any command
- Establishing a new pattern not covered by existing docs
- Deprecating or removing a command or flag

### ADR Format

```markdown
# ADR-NNNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
What is the situation? What constraints or requirements exist?

## Decision
What did we decide to do?

## Consequences
What are the trade-offs? What becomes easier or harder?
```

## Documentation Expectations

- **README**: always reflects actual install and usage instructions
- **`--help` text**: updated whenever flags or commands change; treat it as part of the public API
- **architecture.md**: updated when subsystem structure or data flow changes
- **ADRs**: written before merging significant decisions, not after
- **AI_CONTEXT.md**: updated when adding new commands or changing patterns

## AI Collaboration Guidelines

This project is configured for AI-assisted development. Read `AI_CONTEXT.md` before working on the codebase.

### For AI Agents

- Read `AI_CONTEXT.md` before starting any task
- Follow the check module pattern exactly (each `checks/<name>.ts` exports one `runX` returning `CheckSetResult`) - do not invent new file layouts
- Use the exit code table from architecture.md for all error paths
- Write `--help` text for every new flag and command
- Match the test naming convention
- Do not add dependencies without creating an ADR

### For Developers Working with AI

- Point the agent to the specific command file and test file to modify
- Provide the expected `--help` output as part of the specification
- Review exit code handling and stderr vs stdout routing carefully
- Run the full test suite after AI-generated changes
- Update `AI_CONTEXT.md` if new patterns are introduced

## Communication

- Prefer async: comments on PRs and issues over meetings
- Document decisions in ADRs, not chat logs
- Changelog entries are written from the user's perspective, not the developer's
