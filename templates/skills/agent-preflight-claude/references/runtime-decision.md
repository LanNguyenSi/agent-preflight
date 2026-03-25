# Runtime Decision

Default path:

```bash
preflight run . --json
```

Use sandbox when the host lacks required dependencies:

```bash
preflight sandbox . --json
```

Use Docker socket passthrough only for `act`:

```bash
preflight sandbox . --docker-socket --ci-simulation --json
```

Claude should explicitly mention when a limitation was removed by rerunning in sandbox mode.
