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

## Sandbox Fallback

Use sandbox execution when:

- host runs show missing-tool limitations
- the repo needs cross-stack tooling like `composer`, `mvn`, `gradle`, `phpstan`, `mypy`, or `act`
- you want a more reproducible runtime

Command:

```bash
./agent-preflight-sandbox --build -- run /workspace --json
```

For `act` inside the container:

```bash
./agent-preflight-sandbox --build --docker-socket -- run /workspace --ci-simulation --json
```

## Reporting

Always say whether the reported result came from:

- host `preflight`
- sandbox `agent-preflight-sandbox`
- both, with the sandbox as fallback
