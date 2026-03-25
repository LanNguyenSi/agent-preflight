# agent-preflight

A TypeScript CLI tool that runs CI preflight validation for AI agents. Uses act (nektos/act) as a local CI simulation engine plus direct lint and audit checks. Outputs structured JSON with pass/fail status, confidence score, and explicit limitations so agents know exactly what could not be validated locally before pushing.

## Overview

`agent-preflight` is a command-line tool built with **python** and **typer**.
It is distributed as a Python package via PyPI.

## Installation

### Via pip

```bash
pip install agent-preflight
```

### Via pipx (recommended for isolated install)

```bash
pipx install agent-preflight
```

### From source

```bash
git clone https://github.com/your-org/agent-preflight.git
cd agent-preflight
pip install -e ".[dev]"
```

## Quick Start

```bash
# Show help
agent-preflight --help

# Show version
agent-preflight --version

# Run the default command
agent-preflight run

# Get help for a subcommand
agent-preflight run --help
```

## Usage

### Global Options

| Option | Description |
|--------|-------------|
| `--help` | Show help and exit |
| `--version` | Show version and exit |
| `--config PATH` | Path to config file (default: `~/.config/agent-preflight/config.yaml`) |
| `--verbose` | Enable verbose output |
| `--quiet` | Suppress non-error output |
| `--no-color` | Disable colored output |

### Commands

#### `agent-preflight run`

Execute the primary action.

```bash
agent-preflight run [OPTIONS] [ARGS]...

Options:
  --dry-run   Show what would happen without making changes
  --output    Output format: text, json, yaml  [default: text]
  --help      Show this message and exit
```

#### `agent-preflight config`

Manage tool configuration.

```bash
agent-preflight config show              # Print current config
agent-preflight config set KEY VALUE     # Set a config value
agent-preflight config get KEY           # Get a config value
agent-preflight config reset             # Reset to defaults
```

#### `agent-preflight version`

Show detailed version information.

```bash
agent-preflight version
# agent-preflight v0.1.0
# Language: python
# Framework: typer
# Build: (commit hash)
```

## Configuration

agent-preflight stores configuration at:

- **Linux/macOS**: `~/.config/agent-preflight/config.yaml`
- **Windows**: `%APPDATA%\agent-preflight\config.yaml`

The `--config` flag overrides the default path.

### Example config file

```yaml
# agent-preflight configuration
output_format: text
color: true
verbose: false
# Add your settings here
```

### Environment Variables

All config keys can be overridden via environment variables prefixed with `AGENT_PREFLIGHT_`:

```bash
export AGENT_PREFLIGHT_OUTPUT_FORMAT=json
export AGENT_PREFLIGHT_VERBOSE=true
```

Priority order (highest to lowest): CLI flags > environment variables > config file > defaults.

## Project Structure

```
agent-preflight/
├── src/
│   ├── commands/         # One file per subcommand
│   ├── config/           # Config loading and validation
│   └── main.py
├── tests/
│   └── ...               # Test files mirroring src/
├── docs/
│   ├── architecture.md
│   ├── ways-of-working.md
│   └── adrs/
├── AI_CONTEXT.md
└── README.md
```

## Development

### Prerequisites

- Python 3.11+
- [uv](https://github.com/astral-sh/uv) or pip

### Setup

```bash
git clone https://github.com/your-org/agent-preflight.git
cd agent-preflight

# Create virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install with dev dependencies
pip install -e ".[dev]"
```

### Running Tests

```bash
pytest tests/
pytest tests/ -v --tb=short   # Verbose output
pytest tests/ --cov=src       # With coverage
```

### Linting and Formatting

```bash
ruff check src/ tests/
ruff format src/ tests/
mypy src/
```

## CI/CD

Continuous integration runs on every pull request and push to `main`:

- Lint and format check
- Unit tests
- Build verification
- Publish to PyPI on tagged releases

See `.github/workflows/` for pipeline definitions.

## Testing

Strategy: **unit-tests**

Tests cover individual commands, argument parsing, config loading, and output formatting.
Run them with the command shown in the Development section above.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with tests
4. Run the full test suite
5. Open a pull request

See [ways-of-working](docs/ways-of-working.md) for full contribution guidelines.

## License

MIT License. See [LICENSE](LICENSE) for details.

---

*Generated with [ScaffoldKit](https://github.com/scaffoldkit)*
