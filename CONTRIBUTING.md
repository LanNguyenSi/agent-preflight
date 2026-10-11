# Contributing to agent-preflight

Thanks for your interest. agent-preflight is a CI preflight validation tool: local simulation via `act` plus direct lint/test/audit checks with confidence scoring, run before `git push`.

## Issues

- Bug reports: include repro steps, expected vs. actual, the failing check (lint, test, audit, secrets, etc.), Node version.
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `main` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the same checks as CI before pushing:

   ```bash
   npm install
   npm run build
   npx tsc --noEmit -p tsconfig.test.json
   npx vitest run --coverage
   ```

   `npm run build` does not typecheck the test files; `npx tsc --noEmit -p tsconfig.test.json` does, as in CI. `npx vitest run --coverage` is the test run CI uses; it fails when coverage drops below the thresholds in `vitest.config.ts`. Optionally also run `npm run lint` (CI does not run it) and `node dist/cli.js run .` to dogfood preflight on the repo.

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
