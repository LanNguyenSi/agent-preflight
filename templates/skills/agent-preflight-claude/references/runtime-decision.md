# Runtime Decision

Default path:

```bash
preflight run . --json
```

`preflight run` executes commands the target repository defines (for example `customChecks` and `commands.*` in its `.preflight.json`, and the lint/test scripts it autodetects), so run it only on trusted repositories; see the [security note](https://github.com/LanNguyenSi/agent-preflight/blob/main/docs/checks.md#custom-checks).

Use sandbox when the host lacks required dependencies:

```bash
preflight sandbox . --json
```

Sandbox mode needs a source checkout, an `install.sh` install or a release bundle of agent-preflight; the npm package does not include the image sources, and `preflight sandbox` then stops with `Sandbox Dockerfile not found`.

Use Docker socket passthrough only for `act`:

```bash
preflight sandbox . --docker-socket --ci-simulation --json
```

Use `--docker-socket --ci-simulation` only on trusted repositories; see the [security note](https://github.com/LanNguyenSi/agent-preflight/blob/main/docs/checks.md#custom-checks).

Claude should explicitly mention when a limitation was removed by rerunning in sandbox mode.
