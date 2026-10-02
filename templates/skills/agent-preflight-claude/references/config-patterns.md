# Config Patterns

Use the repository's `.preflight.json` and intended verification scope when choosing commands. See the [configuration reference](https://github.com/LanNguyenSi/agent-preflight/blob/main/docs/checks.md) for the full contract.

## Monorepo subdirectory and command objects

```json
{
  "workingDir": "apps/api",
  "requiredChecks": ["lint", "typecheck", "test"],
  "commands": {
    "lint": ["npm run lint"],
    "typecheck": ["npm run typecheck"],
    "test": [
      { "run": "npm run test:unit", "name": "unit", "timeoutMs": 60000 },
      { "run": "npm run test:contract", "name": "contracts", "cwd": "../contracts", "timeoutMs": 120000 }
    ]
  }
}
```

`commands.lint`, `typecheck`, `test` and `audit` accept strings and objects in the same list. `run` is required; `name`, `cwd`, `timeoutMs`, `passRegex` and `failRegex` are optional. `failRegex` requires `passRegex`; both patterns use the multiline (`m`) flag against the whole combined stdout and stderr up to 131072 UTF-16 code units, or else its first and last 65536 code units, each searched on its own (the middle is not searched and no pattern matches across it; `passRegex` sees only complete lines of those parts, `failRegex` the whole parts, so a line partly cut at a window edge can still veto). Relative `cwd` resolves against the effective `workingDir`; absolute paths also work. Timeouts are positive finite milliseconds, at most `86400000` (one day), with defaults of `300000` for tests and `120000` for the other configured categories. An omitted category or `[]` keeps auto-detection. Malformed explicit overrides fail that enabled category before any of its commands execute; they do not select defaults. String commands use exit codes. An object with `passRegex` passes when it matches and `failRegex` does not, regardless of exit code; timeouts, signals, spawn errors and exit 127 never pass.

## PHP project

Choose config paths and suite names that exist in the project:

```json
{
  "requiredChecks": ["lint", "typecheck", "test"],
  "commands": {
    "lint": ["vendor/bin/pint --test"],
    "typecheck": ["vendor/bin/phpstan analyse --configuration phpstan.neon"],
    "test": [{ "run": "vendor/bin/phpunit --configuration phpunit.xml --testsuite Unit", "name": "unit" }],
    "audit": ["composer audit --format=json"]
  }
}
```

Auto-detected PHP tools honor Composer `config.bin-dir` (default `vendor/bin`). Explicit paths in the example must be adjusted for a different bin directory. PHPStan and PHPCS need a supported config in the target directory or a parent through the Git root; otherwise preflight reports a limitation. Without Git, config discovery stays in the target directory. Bare PHPUnit is not auto-run: use an explicit `commands.test` entry or a Composer `test` script. Explicit scripts can depend on databases or services and can have side effects.

## Java project

```json
{
  "commands": {
    "typecheck": ["./mvnw -q -DskipTests compile"],
    "test": ["./mvnw -q test"]
  }
}
```

## Interpretation notes

- `requiredChecks` uses result kinds such as `git-state`, `lint`, `typecheck`, `test`, `audit`, `ci-simulation`, `commit-convention`, `secret-detection`, `tdd` and `custom`. It does not enable a disabled check.
- Each required kind needs at least one returned result, and every result of that kind must pass. Missing, disabled, skipped, warned, acknowledged and failed required checks block readiness. Omitted or empty lists keep the existing gate; malformed policies block readiness.
- A waived failure keeps status `acknowledged` and its reason. Scan `checks[]` and report it even when optional; it cannot satisfy `requiredChecks`.
- Limitations remain visible. Required checks do not prove exhaustive tool discovery; explicit command lists define the intended verification scope.
- `customChecks` use their separate `command` field. `failOnError: false` produces a warning on failure, which blocks only if `custom` is required.
