# agent-preflight

Validate your repo locally before pushing, with a confidence score an agent can read.

> Planned with [agent-planforge](https://github.com/LanNguyenSi/agent-planforge), generated with [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit), guided by [agent-engineering-playbook](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/agent-engineering-playbook)

## Overview

agent-preflight runs lint, typecheck, test, dependency audit, secret detection, commit-convention, and (optionally) an `act`-based CI dry-run that validates your GitHub Actions workflow plan against your working tree, then returns a structured result with a confidence score between 0 and 1. It exists to break the "change, push, wait for CI, fix, repeat" loop that AI agents run into when they cannot tell whether the pipeline will accept their work. Local validation, JSON output, deterministic scoring.

## Key features

- Lint, typecheck, test, dependency audit, secret detection, and commit-convention checks with auto-detected commands for Node, Python, PHP, and Java
- Optional `act`-based CI dry-run that validates your GitHub Actions workflow plan
- A deterministic confidence score (0-1) instead of a plain pass/fail
- Human-readable or `--json` output for direct agent consumption
- An MCP server (`preflight-mcp`) exposing the same runner in-process
- `preflight batch` to run across every git repo under a root
- `preflight sandbox` to run the same checks inside a Docker image

## Quick start

Requires Node.js 18+; [act](https://github.com/nektos/act) and Docker are only needed for the optional CI simulation and sandbox modes. Host-mode checks need the target stack's own tools on `PATH` (`ruff`, `mypy`, `pytest`, `composer`, `mvn`, and so on); sandbox mode bundles those into the Docker image instead. `install.sh` puts `preflight`, `preflight-sandbox`, and `preflight-mcp` in `~/.local/bin` (override with `PREFLIGHT_BIN_DIR`).

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

## Usage

```bash
preflight run                              # current dir
preflight run ./my-project --json          # machine-readable
preflight run --ci-simulation              # add act --dryrun CI plan validation
preflight run . --config ../shared/preflight.json   # config file outside the repo
preflight batch ~/git                      # every repo under a root
preflight sandbox                          # run inside a docker image
```

A run prints a summary and exits non-zero when not ready:

```
preflight: READY (confidence: 89%)

Warnings:
  4 recent commit(s) don't follow conventional format

Limitations (not validated locally):
  secret detection uses pattern matching; not exhaustive
  CI simulation skipped (enable with checks.ciSimulation: true, requires act)

Checks: 9 | Duration: 20544ms
```

`--json` prints the same result as a structured object (`ready`, `confidence`, `checks`, `blockers`, `warnings`, `limitations`, `durationMs`, `timestamp`, and for `run` also `config`, the config source) for an agent to parse. `run --json` and `batch --json` both write their full JSON envelope before exiting; a consumer piping either command's output must read stdout concurrently with the process, not wait for exit.

Security: a target repo's `.preflight.json` can define shell commands that run on your machine, so only run `preflight batch` (or `run`/`sandbox`/the MCP server) against repositories you trust; see [docs/checks.md](docs/checks.md#custom-checks) for the full note. On the MCP server, `customChecks` and `commands.*` from the repo config are skipped by default: only the exact value `1` of `PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS` in the MCP server's environment enables them, and every skipped entry is reported as a check with status `skip` whose message names that variable. When a kind's configured commands are skipped, that kind is also switched off for the run, so the repo's autodetected script for it (for example `npm run lint`) does not run in their place; the kind reports only its `skip` entries. A malformed `commands` value (a non-array `commands.<kind>`, an array with a malformed entry, or an unrecognized key in `commands`) is not skipped: for an enabled kind it is reported as a `<kind>:configuration` failure exactly like the CLI, so readiness is false, and nothing executes (a kind whose check is switched off reports nothing, as on the CLI). The CLI (`run`/`batch`/`sandbox`) is unchanged. This gate does not make the MCP surface execution-free: the built-in checks that run repo-controlled scripts (for example `npm run lint` or `npm test` from the target's `package.json`, `pytest`, composer scripts) and `setup.enabled` in a repo config still run, so keep pointing the tools at trusted repositories. CI simulation (`checks.ciSimulation` from the repo config, or the caller's `ciSimulation` argument) is gated too: while the variable is not `1` it does not run `act` at all (the repo's `actFlags`, which could add a self-hosted platform mapping, and an `.actrc` in the repo would otherwise reach it), it reports an `act-dry-run` check with status `skip`, and one `limitations` line says so; the repo's `actFlags` are ignored in that case.

CI simulation runs `act` against repository-controlled configuration: the repo's `actFlags` (in `.preflight.json`), the repo's `.actrc` (act reads it from the working directory), and the repo's workflow files with their `runs-on` labels. Treat enabling it as executing repository code. With act 0.2.89, a self-hosted platform mapping (`-P <label>=-self-hosted`) for any label the workflow uses, supplied through `actFlags` or through `.actrc`, runs the `run:` steps on the host even under the leading `--dryrun`; `--dryrun=false` together with a container platform runs the steps inside a job container that has the host Docker socket. The CLI's default `--platform ubuntu-latest=...` only overrides the label it names, so it does not neutralise an `.actrc` that maps any other label. Neither an operator-supplied `--config` nor the absence of a repo `.preflight.json` prevents the `.actrc` path, and filtering `--dryrun=false` from `actFlags` would close neither the `actFlags` nor the `.actrc` self-hosted path. preflight has no `act` flag filtering.

The measured cases below are examples of that rule, not an exhaustive list: other `act` versions and other flag or config combinations were not measured and are not claimed safe. Each used a fixture workflow whose single step writes a marker file or prints a line.

1. `act --dryrun --json -P ubuntu-latest=-self-hosted` (the argv preflight builds from an `actFlags` of `["-P", "ubuntu-latest=-self-hosted"]`): the step ran on the host and left its marker file on three of three runs, while every job log line reported `"dryrun":true`. A run without `--dryrun` also wrote the marker.
2. A repo `.actrc` containing `-P ubuntu-22.04=-self-hosted` and a workflow with `runs-on: ubuntu-22.04`, with the default `actFlags` (argv `act --dryrun --json --platform ubuntu-latest=catthehacker/ubuntu:act-latest`): the step ran on the host on three of three raw `act` runs. The same host execution was observed once each through `preflight run --ci-simulation` in a repo with no `.preflight.json`, through a repo `.preflight.json` that sets only `checks` toggles (no `actFlags`), and through `preflight run --config <operator file>` that enables `ciSimulation`. With the same workflow and no `.actrc`, and with a workflow on `runs-on: ubuntu-latest` and an `.actrc` mapping `ubuntu-latest`, act selected a container image (in the second run the default `--platform` replaced the mapping) and then failed at job setup for lack of a daemon; neither run shows that a dry run is safe.
3. With a reachable Docker daemon and a local container image, `act --dryrun --json --dryrun=false -P ubuntu-latest=node:22-slim --pull=false` ran the step inside the job container (its output appeared, and a listing from inside the container showed `/var/run/docker.sock`), while the same argv without `--dryrun=false` showed no step output and no `docker exec` in its log.

Cases 1 and 2 were measured in a Linux container without a reachable Docker daemon (a self-hosted mapping needs none); in that environment the case 2 runs without a self-hosted mapping failed at job setup for lack of a daemon, and a run with neither a mapping nor `--platform` stopped earlier, at act's interactive image prompt, so none of those runs shows that a dry run is safe. Case 3 was measured with a reachable daemon.

Entry points: `--ci-simulation`, `checks.ciSimulation: true` (a repo can set this in its own `.preflight.json`, so a plain `preflight run` against such a repo is enough), `sandbox --ci-simulation` (act runs inside the sandbox container, which is not an isolation boundary: the workspace and package caches are mounted writable, and `--docker-socket`, which the shipped skill templates use for CI simulation, mounts the host Docker socket), and the MCP server, which runs `act` only with `PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1`.

Operative guidance: run preflight, and CI simulation in particular, only against repositories you trust. Such a repository can already run arbitrary shell through `customChecks`, `commands.*` and its package scripts. No configuration of CI simulation is claimed safe for an untrusted repository.

## Configuration

Use `.preflight.json` for project-specific command strings or objects with `run`, `name`, `cwd` and `timeoutMs`. Opt in to `"requiredChecks": ["lint", "typecheck", "test"]` when missing or non-passing results must block readiness. Without that policy, the existing gate is unchanged. PHP test execution requires an explicit command or a Composer `test` script; bare PHPUnit is no longer auto-run. `preflight run` can read a config file outside the repo with `--config <path>` or the `PREFLIGHT_CONFIG` environment variable (precedence `--config` > `PREFLIGHT_CONFIG` > `.preflight.json`, no merging; a relative path is resolved against the current directory, not the repo; a missing or invalid explicit file is an error, not a fallback, and any validation warning in it is fatal). The result names the source in `config` (`option`, `env`, `repo` or `none`, with the path; `none` also when a broken repo file made defaults apply). The MCP `preflight_run` tool takes the same as `configPath`; `batch` and `sandbox` do not support it (`sandbox` rejects it). Like `.preflight.json`, an explicit file can define shell commands, so only use files you trust. `PREFLIGHT_CONFIG` is removed by the shared command runner (`runShellCheck`) from the environment of configured checks and other commands routed through it. Direct subprocess paths, including the built-in npm audit runner and `act` CI simulation, currently inherit it; other direct children are outside this filter. This is a command-runner boundary, not a guarantee that every child process lacks the selector. See the [checks and configuration reference](docs/checks.md) for examples, PHP discovery and migration details.

## Documentation

- [docs/checks.md](docs/checks.md): what each check verifies, toggles, auto-detection, monorepo setup, and the build-required test classification, waiver, and secret-detection-fixture rules
- [docs/confidence-scoring.md](docs/confidence-scoring.md): the scoring model, default weights, and reading the result
- [docs/architecture.md](docs/architecture.md): CLI internals, the run/batch/sandbox pipeline, act integration, and the MCP server
- [docs/integration.md](docs/integration.md): wiring agent-preflight into agent-tasks, agent-relay, and harness as a claim gate
- [docs/secret-scanner-investigation.md](docs/secret-scanner-investigation.md): investigation into the secret-detection engine's current regex approach versus gitleaks and trufflehog
- [docs/ways-of-working.md](docs/ways-of-working.md): contributor conventions (definition of done, CLI UX rules)
- Skill templates for adapting agent-preflight into agent workflows: [agent-preflight](./templates/skills/agent-preflight/SKILL.md), [agent-preflight-opencode](./templates/skills/agent-preflight-opencode/SKILL.md), [agent-preflight-claude](./templates/skills/agent-preflight-claude/SKILL.md)

## Development and contributing

```bash
npm install
npm run build
npm test
npm run lint
```

`make release-bundle` produces `out/release/agent-preflight-v<version>-bundle.tar.gz` plus a `.sha256`; bundle installs require `node` but not `npm`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow and dev setup.

## License

MIT
