# Architecture

`agent-preflight` is a TypeScript CLI built on top of [`commander`](https://www.npmjs.com/package/commander) and [`execa`](https://www.npmjs.com/package/execa). One binary (`preflight`), three subcommands (`run`, `batch`, `sandbox`), and a set of independent check modules behind them. No daemon, no server, no shared state.

## Top-level layout

```
src/
  cli.ts              # commander entry, parses flags, dispatches subcommands
  config.ts           # loads .preflight.json, applies defaults
  runner.ts           # orchestrates a single repo, computes confidence
  batch.ts            # walks a root directory, runs runner per repo
  sandbox.ts          # builds the docker plan, runs preflight in a container
  types.ts            # PreflightConfig, PreflightResult, CheckResult, CheckKind
  version.ts          # injected at build time
  checks/
    git.ts            # clean-worktree, protected-branch
    lint.ts
    typecheck.ts
    test.ts
    audit.ts
    secrets.ts
    commits.ts        # commit convention
    tdd.ts            # changed-file vs test-file pairing
    ci.ts             # act-based CI simulation
    custom.ts         # user-defined shell checks
    shared.ts         # project detection, runner helpers, setup phase
```

Tests live under `tests/` and mirror the `src/` layout. Build output goes to `dist/`.

## How a single run works

`preflight run [repoPath]` flows through these steps:

1. `cli.ts` parses flags, resolves the target path to an absolute path, calls `loadConfig`.
2. `config.ts` reads `.preflight.json` if present and merges it with defaults from `types.ts`. Missing files are not an error; the tool works without config.
3. `runner.ts` dynamically imports each enabled check module. Imports are dynamic so a missing optional dependency in one check never breaks the others.
4. Each check returns a `CheckSetResult` of `{ checks, limitations }`. The runner pushes them into a flat list, picks blockers (`fail`) and warnings (`warn`), deduplicates limitations, and computes the confidence score.
5. `cli.ts` formats the result. `--json` prints `JSON.stringify(result, null, 2)`. The default formatter renders the icon, the score, the blockers, the warnings, and the limitations.
6. Exit code is `0` when `ready` is true, otherwise `1`.

The shape of `PreflightResult` is the contract:

```ts
interface PreflightResult {
  ready: boolean;
  confidence: number;          // 0..1
  checks: CheckResult[];
  blockers: string[];
  warnings: string[];
  limitations: string[];
  durationMs: number;
  timestamp: string;
}
```

## Exit codes

The exit code is the machine-readable verdict; it is the contract `docs/integration.md` and `docs/ways-of-working.md` rely on.

| Command | Exit `0` | Exit `1` |
|---------|----------|----------|
| `preflight run [repoPath]` | `ready` is true (no blocking `fail` checks) | `ready` is false |
| `preflight batch [root]` | every repo is ready (`notReady` is 0) | one or more repos are not ready |
| `preflight sandbox [repoPath]` | the in-container `preflight run` exited 0 | the in-container run exited non-zero (or the container failed to start) |

There is no distinct usage-error code: invalid flags or unknown commands are handled by `commander`, which prints the error to stderr and exits non-zero. Confidence is reported in the payload, not the exit code: a low-confidence run can still exit `0` when nothing blocked.

## act integration

`act` can run GitHub Actions workflows locally inside Docker. `checks/ci.ts` invokes it in `--dryrun` mode (`act --dryrun --json`), which validates the workflow plan (jobs, steps, and runner images) without executing any step. It shells out once, wires `actFlags` from `.preflight.json` (defaulting to `--platform ubuntu-latest=catthehacker/ubuntu:act-latest`), and produces a single aggregated check entry named `act-dry-run` weighted at `0.25`, regardless of how many workflows the repo defines. CI simulation is opt-in (`--ci-simulation` or `checks.ciSimulation: true`) because it is the slowest check and depends on the host having Docker plus a usable `act` binary.

In sandbox mode the act invocation runs inside the container. `--docker-socket` mounts `/var/run/docker.sock` so the `act` binary inside the container can reach the host Docker daemon.

## Sandbox

`preflight sandbox [repoPath]` builds an image fingerprint from the target repo's manifests, in `sandbox.ts`:

- Node and TypeScript: `package.json`, `tsconfig.json`
- Python: `pyproject.toml`, `setup.py`, `requirements.txt`
- PHP: `composer.json`, plus `ext-*` requirements mapped to apt packages
- Symfony: `symfony.lock`, `bin/console`, or `symfony/*` Composer packages
- Java: Maven (`pom.xml`) and Gradle (`build.gradle`, `build.gradle.kts`) manifests

The fingerprint determines the local image tag (default `agent-preflight:local`), which lets switching between repos pick up different prepared images automatically. `.preflight.json` extras (`sandbox.aptPackages`, `sandbox.pipPackages`) are merged into the build. `--print` shows the resolved docker command without running it. `--build` and `--pull` force the image to refresh.

## Batch mode

`preflight batch [root]` walks the immediate children of `root`, picks the ones that are git repos, and runs the single-repo path against each. `--only` and `--exclude` accept glob patterns (matched against the directory name). Output aggregates into a per-repo summary plus counts (`ready`, `notReady`, `skipped`). Inspired by [`git-batch-cli`](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/git-batch-cli).

## Setup phase

Opt-in via `--setup` or `setup.enabled: true`. `checks/shared.ts` runs only the unambiguous dependency-bootstrap commands per stack (`npm ci` when `package-lock.json` exists, `composer install` when `vendor/` is missing, etc.). Any setup work appends an entry to `limitations` so the agent can see what was prepared automatically. See [checks.md](./checks.md#setup-phase) for the full list.

## Module boundaries

Each `checks/<name>.ts` exports a single `runX(targetPath, config)` function returning `CheckSetResult`. They never read the filesystem or shell out outside their own scope, never mutate the runner's state directly, and never import from each other except through `shared.ts`. This is the property that lets the runner add or remove a check without touching the others.

## CI for this repo

GitHub Actions workflows live under `.github/workflows/`. The pipeline runs the same lint, typecheck, and test commands the tool itself runs on its target. Release bundles are produced with `make release-bundle`, which writes `out/release/agent-preflight-v<version>-bundle.tar.gz` plus an SHA256.
