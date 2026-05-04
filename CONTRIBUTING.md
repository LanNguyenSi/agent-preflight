# Contributing to agent-preflight

Thanks for your interest. agent-preflight is a CI preflight validation tool: local simulation via `act` plus direct lint/test/audit checks with confidence scoring, run before `git push`.

## Issues

- Bug reports: include repro steps, expected vs. actual, the failing check (lint, test, audit, secrets, etc.), Node version.
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `main` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the project's own preflight on your changes before pushing:

   ```bash
   npm install
   npm run build
   npm test
   ```

4. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/agent-preflight
cd agent-preflight
npm install
npm run build
npm test
```

## Style

Match the surrounding code. Prefer small, reviewable diffs.
