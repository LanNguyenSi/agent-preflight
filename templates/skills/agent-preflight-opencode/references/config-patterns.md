# Config Patterns

Use the repo's `.preflight.json` as the source of truth when it exists.

Typical OpenCode cases:

- monorepo service work: set `workingDir`
- PHP or Java repo: use explicit `commands.*`
- project-specific smoke validation: use `customChecks`

Examples:

```json
{
  "workingDir": "services/api"
}
```

```json
{
  "commands": {
    "lint": ["vendor/bin/pint --test"],
    "typecheck": ["vendor/bin/phpstan analyse"],
    "test": ["vendor/bin/phpunit"]
  }
}
```
