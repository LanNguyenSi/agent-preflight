# Runtime Decision

Default path:

```bash
preflight run . --json
```

Use sandbox when the host lacks required dependencies:

```bash
./agent-preflight-sandbox --build -- run /workspace --json
```

Use Docker socket passthrough only for `act`:

```bash
./agent-preflight-sandbox --build --docker-socket -- run /workspace --ci-simulation --json
```

Claude should explicitly mention when a limitation was removed by rerunning in sandbox mode.
