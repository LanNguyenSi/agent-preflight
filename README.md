# agent-preflight

Validate your repo locally before pushing, with a confidence score an agent can read.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge), generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit), guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/agent-engineering-playbook)

## Overview

agent-preflight runs lint, typecheck, test, dependency audit, secret detection, commit-convention, and (optionally) an `act`-based CI simulation (`act --dryrun` against your working tree, which runs `act` against repository-controlled configuration and can still execute workflow steps; the [security note](docs/checks.md#custom-checks) lists the measured cases, what preflight refuses, and what it does not cover), then returns a structured result with a confidence score between 0 and 1. It exists to break the "change, push, wait for CI, fix, repeat" loop that AI agents run into when they cannot tell whether the pipeline will accept their work. Local validation, JSON output, deterministic scoring.

## Key features

- Lint, typecheck, test, dependency audit, secret detection, and commit-convention checks with auto-detected commands for Node, Python, PHP, and Java
- Optional `act`-based CI simulation (`act --dryrun`); it runs `act` against repository-controlled configuration and can still execute workflow steps; the [security note](docs/checks.md#custom-checks) lists the measured cases, what preflight refuses, and what it does not cover
- A deterministic confidence score (0-1) instead of a plain pass/fail
- Human-readable or `--json` output for direct agent consumption
- An MCP server (`preflight-mcp`) exposing the same runner in-process
- `preflight batch` to run across every git repo under a root
- `preflight sandbox` to run the same checks inside a Docker image

## Quick start

Requires Node.js 20.19+ or 22.12+ (the CLI is built as CommonJS and loads the ESM-only `execa` with `require`); [act](https://github.com/nektos/act) and Docker are only needed for the optional CI simulation and sandbox modes. Host-mode checks need the target stack's own tools on `PATH` (`ruff`, `mypy`, `pytest`, `composer`, `mvn`, and so on); sandbox mode bundles those into the Docker image instead. `install.sh` puts `preflight`, `preflight-sandbox`, and `preflight-mcp` in `~/.local/bin` (override with `PREFLIGHT_BIN_DIR`) and copies the runtime to `~/.local/share/agent-preflight` (override with `PREFLIGHT_INSTALL_DIR`).

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
./install.sh
# reload your shell rc file; install.sh prints which one it edited (~/.zshrc, ~/.bashrc or ~/.profile)

# run against any local repo (or the current directory)
preflight run .
```

Or run the scoped npm package directly:

```bash
npx -y @lannguyensi/agent-preflight run .
```

To select the `preflight` executable explicitly, use the package flag:

```bash
npx -y -p @lannguyensi/agent-preflight preflight run .
```

The package exposes `agent-preflight` and `preflight` for the same CLI,
plus `preflight-mcp` for the MCP server. To install via npm:

```bash
npm install -g @lannguyensi/agent-preflight
preflight run .
```

The npm package contains the CLI and the MCP server. `preflight sandbox` builds its image from the `Dockerfile` and sources next to the installed CLI, and the npm package does not include them, so sandbox mode needs a source checkout, an `./install.sh` install or a release bundle. From an npm or npx install, `preflight sandbox` stops with `preflight: Sandbox Dockerfile not found in <dir>.`, also with `--print` or `--image`. Not shipping the `Dockerfile`, sources and lockfile in the npm package is a deliberate decision, to keep the package small; sandbox mode needs a source checkout.

## Usage

```bash
preflight run                              # current dir
preflight run ./my-project --json          # machine-readable
preflight run --ci-simulation              # add an act --dryrun CI simulation, which can still execute steps (trusted repos only, see docs/checks.md#custom-checks)
preflight run . --config ../shared/preflight.json   # config file outside the repo
preflight batch ~/git                      # every repo under a root
preflight sandbox                          # run inside a docker image
```

Options per subcommand (`preflight --version` and `--help` are global; every subcommand also takes `--help`):

| Option | Subcommands | Effect |
|--------|-------------|--------|
| `--json` | `run`, `batch`, `sandbox` | Print the result as JSON instead of the summary |
| `--config <path>` | `run` | Load this config file instead of `<repoPath>/.preflight.json` (see [Configuration](#configuration)); `sandbox` rejects it, `batch` has no such option |
| `--setup` | `run`, `batch`, `sandbox` | Run the conservative dependency and build bootstrap before the checks |
| `--ci-simulation` | `run`, `sandbox` | Add the `act` CI simulation (trusted repos only); `batch` has no such option, but a repo's own `checks.ciSimulation: true` still applies there |
| `--no-audit`, `--no-secrets` | `run`, `batch`, `sandbox` | Skip the dependency audit or secret detection (on `sandbox` they are passed into the container) |
| `--only <pattern>`, `--exclude <pattern>` | `batch` | Include or exclude repos whose directory name matches the glob |
| `--build` | `sandbox` | Build the sandbox image before starting |
| `--pull` | `sandbox` | Run `docker pull` on the image first; only works for a registry image given with `--image` |
| `--print` | `sandbox` | Print the docker commands and exit without running them |
| `--docker-socket` | `sandbox` | Mount `/var/run/docker.sock` so `act` in the container reaches the host Docker daemon |
| `--image <image>` | `sandbox` | Run this image instead of the computed local sandbox image |

A run prints a summary and exits non-zero when not ready:

```
✅ preflight: READY (confidence: 89%)

Warnings:
  ⚠ 4 recent commit(s) don't follow conventional format

Limitations (not validated locally):
  ~ secret detection uses pattern matching; not exhaustive
  ~ CI simulation skipped (enable with checks.ciSimulation: true, requires act)

Checks: 9 | Duration: 20544ms
Config: none (defaults) (none)
```

Failures waived with `acknowledge` appear in an `Acknowledged` section, and blockers in a `Blockers` section.

`--json` prints the same result as a structured object (`ready`, `confidence`, `checks`, `blockers`, `warnings`, `limitations`, `durationMs`, `timestamp`, and for `run` also `config`, the config source) for an agent to parse. `run --json` and `batch --json` both write their full JSON envelope before exiting; a consumer piping either command's output must read stdout concurrently with the process, not wait for exit.

Security: preflight executes repository-controlled input, so run it (and the MCP server) only against repositories you trust.

- A target repo's `.preflight.json`, or an explicit `--config` file, can define shell commands (`customChecks`, `commands.*`) that run on your machine. The autodetected checks run the repo's own scripts (for example `npm run lint`, `npm test`, composer scripts), and `--setup` can run its `build` script.
- CI simulation runs `act` against the repo's `actFlags` and workflow files and can still execute workflow steps. preflight refuses some `actFlags` shapes and keeps the repo's `.actrc` out (act would otherwise read it from its working directory); that is not an isolation boundary.
- The MCP server skips repo-defined commands (`customChecks`, `commands.*`) and CI simulation unless its environment sets `PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1`. Autodetected scripts for kinds without configured commands, and `setup.enabled`, still run there.
- The sandbox is not an isolation boundary either: the workspace and package caches are mounted writable, and `--docker-socket` mounts the host Docker socket.

The [security note in docs/checks.md](docs/checks.md#custom-checks) has the full rules: what the MCP gate skips and reports, which `actFlags` preflight refuses, what that does not cover, and the measured cases.

## Configuration

Use `.preflight.json` for project-specific command strings or objects with `run`, `name`, `cwd` and `timeoutMs`. Opt in to `"requiredChecks": ["lint", "typecheck", "test"]` when missing or non-passing results must block readiness. Without that policy, the existing gate is unchanged. PHP test execution requires an explicit command or a Composer `test` script; bare PHPUnit is no longer auto-run. `preflight run` can read a config file outside the repo with `--config <path>` or the `PREFLIGHT_CONFIG` environment variable (precedence `--config` > `PREFLIGHT_CONFIG` > `.preflight.json`, no merging; a relative path is resolved against the current directory, not the repo; a missing or invalid explicit file is an error, not a fallback, and any validation warning in it is fatal). The result names the source in `config` (`option`, `env`, `repo` or `none`, with the path; `none` also when a broken repo file made defaults apply). The MCP `preflight_run` tool takes the same as `configPath`; `batch` and `sandbox` do not support it (`sandbox` rejects it). Like `.preflight.json`, an explicit file can define shell commands, so only use files you trust. `PREFLIGHT_CONFIG` is removed by the shared command runner (`runShellCheck`) from the environment of configured checks and other commands routed through it. Direct subprocess paths, including the built-in npm audit runner and `act` CI simulation, currently inherit it; other direct children are outside this filter. This is a command-runner boundary, not a guarantee that every child process lacks the selector. See the [checks and configuration reference](docs/checks.md) for examples, PHP discovery and migration details.

## Documentation

- [docs/checks.md](docs/checks.md): what each check verifies, toggles, auto-detection, monorepo setup, and the build-required test classification, waiver, and secret-detection-fixture rules
- [docs/confidence-scoring.md](docs/confidence-scoring.md): the scoring model, default weights, and reading the result
- [docs/architecture.md](docs/architecture.md): CLI internals, the run/batch/sandbox pipeline, act integration, and the MCP server
- [docs/integration.md](docs/integration.md): wiring agent-preflight into agent-tasks and agent harnesses as a claim gate
- [docs/secret-scanner-investigation.md](docs/secret-scanner-investigation.md): investigation into the secret-detection engine's current regex approach versus gitleaks and trufflehog
- [docs/ways-of-working.md](docs/ways-of-working.md): contributor conventions (definition of done, CLI UX rules)
- Skill templates for adapting agent-preflight into agent workflows: [agent-preflight](./templates/skills/agent-preflight/SKILL.md), [agent-preflight-opencode](./templates/skills/agent-preflight-opencode/SKILL.md), [agent-preflight-claude](./templates/skills/agent-preflight-claude/SKILL.md)

## Development and contributing

```bash
npm install
npm run build
npx tsc --noEmit -p tsconfig.test.json   # test-file typecheck, as in CI
npm test
npm run lint                             # not run in CI
```

`make release-bundle` produces `out/release/agent-preflight-v<version>-bundle.tar.gz` plus a `.sha256` (output directory overridable with `RELEASE_OUTPUT_DIR`); bundle installs require `node` but not `npm`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow and dev setup.

## License

MIT
