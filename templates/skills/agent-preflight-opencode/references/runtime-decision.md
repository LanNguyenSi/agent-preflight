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

Use `--docker-socket --ci-simulation` only on trusted repositories; see the [security note](https://github.com/LanNguyenSi/agent-preflight/blob/main/docs/checks.md#custom-checks).

In OpenCode output, explicitly label the final result as `host` or `sandbox`.
