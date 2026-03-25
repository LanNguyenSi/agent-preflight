# Runtime Decision

Run on the host first:

```bash
preflight run . --json
```

Switch to sandbox when host limitations are mainly about missing tools:

```bash
./agent-preflight-sandbox --build -- run /workspace --json
```

For local CI simulation:

```bash
./agent-preflight-sandbox --build --docker-socket -- run /workspace --ci-simulation --json
```

In OpenCode output, explicitly label the final result as `host` or `sandbox`.
