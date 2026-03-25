# ADR-0001: Language and Framework Choice

## Status

Accepted

## Context

agent-preflight is a new CLI tool: A TypeScript CLI tool that runs CI preflight validation for AI agents. Uses act (nektos/act) as a local CI simulation engine plus direct lint and audit checks. Outputs structured JSON with pass/fail status, confidence score, and explicit limitations so agents know exactly what could not be validated locally before pushing.

We needed to select an implementation language and a CLI framework. The following requirements
guided the decision:

- Distribute as: **pip-package**
- Target users are developers comfortable with a terminal
- The tool may be invoked in scripts and CI pipelines, so predictable exit codes and machine-readable output are required
- The codebase should be approachable for contributors familiar with the chosen language

### Options Evaluated

#### Languages

| Language | Strengths | Weaknesses |
|----------|-----------|------------|
| Python | Fast iteration, large library ecosystem, easy scripting | Requires runtime; distribution of executables is complex |
| Go | Compiles to static binary, fast startup, good stdlib | Verbose error handling; less ergonomic for argument parsing |
| Rust | Best performance, memory safety, excellent binary output | Steep learning curve; slower compile times |
| TypeScript | Familiar for web developers, rich ecosystem | Requires Node.js runtime; startup time higher than compiled |

#### CLI Frameworks

| Framework | Language | Strengths |
|-----------|----------|-----------|
| Typer | Python | Type-annotation-first, auto-generates help, integrates with Rich |
| Click | Python | Mature, flexible, decorator-based, well-documented |
| Cobra | Go | De facto Go CLI standard, used by kubectl and many major tools |
| Clap | Rust | Derive-macro ergonomics, excellent validation, shell completions |
| Commander | TypeScript/Node | Most widely used Node CLI library, flexible |

## Decision

We chose **python** with **typer**.

### Rationale

**Python** was selected because the team has strong Python experience and the tool's logic
benefits from Python's rich ecosystem of libraries. Distribution as a pip package is
well-understood and widely supported.

**Typer** was selected over Click because:

- Commands map directly to typed Python functions - less boilerplate
- Help text, types, and defaults are derived from function signatures
- First-class integration with [Rich](https://github.com/Textualize/rich) for formatted output
- Typer is built on Click, so Click patterns apply when needed


### Distribution: pip-package

Distributing as a PyPI package allows users to install with `pip install agent-preflight`
or `pipx install agent-preflight`. This is the standard Python CLI distribution method
and integrates with existing Python toolchains.

## Consequences

### Positive

- Rapid iteration; new commands can be added in minutes
- Full access to Python package ecosystem
- Easy local development setup (`pip install -e ".[dev]"`)

### Negative

- End users must have Python installed (mitigated by pipx or binary packaging with PyInstaller)
- Startup time is higher than compiled languages
- Virtual environment management adds local dev friction

### Risks

- If the distribution model changes later (e.g., from pip to binary), the build pipeline
  will need to be redesigned.
- Adding a new command that requires a heavy dependency should trigger a new ADR to assess
  the impact on binary size or install footprint.

## References

- [Architecture documentation](../architecture.md)
- [Ways of working](../ways-of-working.md)
- [Typer documentation](https://typer.tiangolo.com)
