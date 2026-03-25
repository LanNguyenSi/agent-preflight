# Config Patterns

Claude should treat `.preflight.json` as authoritative.

Common patterns:

```json
{
  "workingDir": "apps/backend"
}
```

```json
{
  "commands": {
    "typecheck": ["./mvnw -q -DskipTests compile"],
    "test": ["./mvnw -q test"]
  }
}
```

```json
{
  "customChecks": [
    {
      "name": "smoke",
      "command": "make smoke",
      "failOnError": false
    }
  ]
}
```
