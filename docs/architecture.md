# Architecture: agent-preflight

## Overview

agent-preflight is a CLI tool implemented in **python** using the **typer** framework.
It follows a command-based architecture where each subcommand is an isolated unit with its own
argument parsing, validation, and execution logic.

## Principles

1. **Single responsibility per command**: Each command file owns one subcommand and nothing else.
2. **Fail fast with clear messages**: Validate inputs at parse time; emit actionable error messages to stderr.
3. **Exit codes are part of the interface**: Always exit with a meaningful code (see Exit Codes below).
4. **Stdout for data, stderr for diagnostics**: Program output goes to stdout; logs, warnings, and errors go to stderr.
5. **Composable with other tools**: Support `--output json` on commands that produce structured data.
6. **Config is optional**: The tool must work with no config file present; config only overrides defaults.

## System Structure

```
agent-preflight/
├── src/
│   ├── commands/         # One module per subcommand
│   │   ├── run.py
│   │   └── config.py
│   ├── config/           # Config file loading, validation, env var merging
│   │   └── loader.py
│   └── main.py
│       # Entrypoint: registers commands, sets global flags
├── tests/
│   ├── commands/         # Tests mirroring src/commands
│   └── config/
└── docs/
```

## Key Subsystems

### 1. Command Parsing (typer)

Commands are defined as Python functions decorated with `@app.command()`. Typer derives
argument names, types, and help text from function signatures and type annotations.

```python
# src/commands/run.py
import typer

def run(
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview without changes"),
    output: str = typer.Option("text", "--output", "-o", help="Output format"),
) -> None:
    """Execute the primary action."""
    ...
```

The root app is created in `src/main.py` and subcommand apps are added with `app.add_typer()`.

### 2. Config Loading

Config is loaded in layers, with later layers overriding earlier ones:

```
1. Compiled-in defaults
2. Config file (~/.config/agent-preflight/config.yaml)
3. Environment variables (AGENT_PREFLIGHT_*)
4. CLI flags passed at runtime
```

The config loader lives in `src/config/`. It is responsible for:

- Locating the config file (respects `--config` flag and `XDG_CONFIG_HOME`)
- Parsing the YAML file into a typed struct/dataclass
- Merging environment variable overrides
- Returning a validated config object to each command

Commands receive config as a parameter; they do not read it directly. This keeps commands
testable without touching the filesystem.

Config file path resolution order:
1. Value of `--config` flag
2. `$AGENT_PREFLIGHT_CONFIG` environment variable
3. `$XDG_CONFIG_HOME/agent-preflight/config.yaml`
4. `~/.config/agent-preflight/config.yaml`

### 3. Output Formatting

Commands should never write directly to stdout with unstructured print statements.
Instead, they call a shared output layer:

- **`output text`**: Human-readable, with optional color (disabled if `NO_COLOR` is set or `--no-color` is passed, or if stdout is not a TTY)
- **`output json`**: Machine-readable JSON, always without color
- **`output yaml`**: Machine-readable YAML, always without color

The output module respects:

- `NO_COLOR` environment variable (per [no-color.org](https://no-color.org))
- `--no-color` flag
- TTY detection: disable color when stdout is piped

### 4. Error Handling and Exit Codes

All errors are caught at the top-level command runner and translated to appropriate exit codes.
Commands signal failure by raising/returning an error - they never call `os.exit()` directly.

#### Exit Code Reference

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General / unspecified error |
| `2` | Invalid arguments or usage error |
| `3` | Configuration error (bad config file, missing required setting) |
| `4` | Runtime error (external service unavailable, permission denied) |
| `5` | Not found (resource the command expected does not exist) |

Error messages follow the pattern: `error: <what went wrong>. <how to fix it>.`

Good: `error: config file not found at ~/.config/agent-preflight/config.yaml. Run 'agent-preflight config init' to create it.`
Bad: `FileNotFoundError: [Errno 2] No such file or directory`

### 5. Logging and Verbosity

Diagnostic output is gated by a verbosity level:

- **Default**: warnings and errors only
- **`--verbose`**: informational messages, command timing
- **`--debug`**: debug-level traces (when applicable)

Structured log lines go to stderr and never to stdout.

## CI/CD Architecture

The pipeline runs on GitHub Actions (`.github/workflows/ci.yml`):

1. **lint** - ruff, mypy
2. **test** - pytest with coverage
3. **build** - `pip build` to verify package is installable
4. **publish** - twine upload on tagged releases

## Testing Strategy

Approach: **unit-tests**

Each command module has a corresponding test file. Tests invoke command functions directly
with controlled inputs - they do not spawn subprocess invocations.

- Commands are tested with mocked config and mocked I/O
- Config loader is tested with temporary files
- Output formatter is tested for both text and JSON modes

## Decisions

See [ADR log](adrs/) for architectural decisions and their rationale.
