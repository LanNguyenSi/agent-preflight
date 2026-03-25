# Runtime Decision

Run on the host first:

```bash
preflight run . --json
```

Switch to sandbox when host limitations are mainly about missing tools:

```bash
preflight sandbox . --json
```

For local CI simulation:

```bash
preflight sandbox . --docker-socket --ci-simulation --json
```

In OpenCode output, explicitly label the final result as `host` or `sandbox`.
