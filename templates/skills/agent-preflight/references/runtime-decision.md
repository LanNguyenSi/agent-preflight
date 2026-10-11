# Runtime Decision

## Host First

Use host execution when:

- the required tools are already installed
- the repo has a lightweight standard stack
- you only need a fast preflight pass

Command:

```bash
preflight run . --json
```

`preflight run` executes commands the target repository defines (for example `customChecks` and `commands.*` in its `.preflight.json`, and the lint/test scripts it autodetects), so run it only on trusted repositories; see the [security note](https://github.com/LanNguyenSi/agent-preflight/blob/main/docs/checks.md#custom-checks).

## Sandbox Fallback

Use sandbox execution when:

- host runs show missing-tool limitations
- the repo needs cross-stack tooling like `composer`, `mvn`, `gradle`, `phpstan`, `mypy`, or `act`
- you want a more reproducible runtime

Command:

```bash
preflight sandbox . --json
```

Sandbox mode needs a source checkout, an `install.sh` install or a release bundle of agent-preflight; the npm package does not include the image sources, and `preflight sandbox` then stops with `Sandbox Dockerfile not found`.

For `act` inside the container:

```bash
preflight sandbox . --docker-socket --ci-simulation --json
```

Use `--docker-socket --ci-simulation` only on trusted repositories; see the [security note](https://github.com/LanNguyenSi/agent-preflight/blob/main/docs/checks.md#custom-checks).

## Reporting

Always say whether the reported result came from:

- host `preflight`
- sandbox `preflight sandbox`
- both, with the sandbox as fallback
