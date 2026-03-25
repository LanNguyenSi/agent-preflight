# Config Patterns

## Common Cases

### Monorepo subdirectory

```json
{
  "workingDir": "apps/api"
}
```

### Node defaults overridden by explicit commands

```json
{
  "commands": {
    "lint": ["npm run lint"],
    "typecheck": ["npx tsc --noEmit"],
    "test": ["npm run test"],
    "audit": ["npm audit --json"]
  }
}
```

### PHP project

```json
{
  "commands": {
    "lint": ["vendor/bin/pint --test"],
    "typecheck": ["vendor/bin/phpstan analyse"],
    "test": ["vendor/bin/phpunit"],
    "audit": ["composer audit --format=json"]
  }
}
```

### Java project

```json
{
  "commands": {
    "typecheck": ["./mvnw -q -DskipTests compile"],
    "test": ["./mvnw -q test"]
  }
}
```

## Interpretation Notes

- Prefer repo-provided commands over tool guesses.
- `customChecks` are useful for smoke commands that are project-specific.
- `failOnError: false` means the custom check should become a warning, not a blocker.
