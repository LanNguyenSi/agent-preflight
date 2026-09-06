# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`--setup` builds the repo before the test check when CI shows build-before-test** (agent-tasks c5810885). `ensureProjectSetup` (`src/checks/shared.ts`) now runs `npm run build` when both hold: `package.json` has a `build` script, AND `.github/workflows/ci.yml` has a `run:` step invoking `npm run build`/`yarn build`/`pnpm build` earlier in the file than a step invoking the test script (`ciShowsBuildBeforeTest`/`workflowTextShowsBuildBeforeTest`). This is a best-effort, single-file, line-order read, not a real Actions execution-graph evaluator: reusable workflows, job `needs:` graphs, and `run: |` block scalars are not modeled, and neither is the real job/`needs:` execution graph (a build step in an unrelated job still reads as "before" a later test job by line order). A miss costs only the extra manual `npm run build` this feature exists to avoid (`--setup` behaves exactly as before, dependency install only); a false hit costs only a redundant rebuild. A `run:` step whose value is itself a shell comment, or that only echoes a string, is recognized and skipped, since neither actually invokes the command. When the build step itself fails or times out under `--setup`, the failure's full stdout+stderr is persisted the same way a failing check's output is, and the downstream test check's failure is never reclassified into a non-blocking skip on account of it (see the `Fixed` entry below); a repo whose CI does not show the build-before-test convention (this repo's own CI included; `vitest` runs TypeScript source directly) gets no extra build step.

### Fixed

- **A `npm-test` failure that only means "run the build first" is no longer a blocker, without hiding a genuinely broken workspace or a genuinely broken build** (agent-tasks c5810885). Reproduced against fixture npm-workspaces monorepos (`tests/fixtures/monorepo-build-required` and others): a workspace whose test requires its own package's `dist/` output failed the default `npm-test` check with a bare `fail`/"npm test failed" in a fresh, unbuilt checkout, exactly the shape reported against a real repo's own CI-verified build-before-test convention. `runTestChecks` (`src/checks/test.ts`) classifies that failure by concrete evidence in the captured output only, via `classifyBuildRequiredTestFailure`/`classifyBuildRequiredFailure` (`src/checks/shared.ts`): Node's own `Cannot find module` naming a path through `dist/`, an `ENOENT` on that path restricted to an actual module-resolution failure (a require/import-shaped entry point plus a `Require stack:`/`ERR_MODULE_NOT_FOUND` marker; a plain `fs` read of an unrelated data file under `dist/` no longer counts), or a workspace's own single-line precondition message naming `dist/`, "missing"/"not found"/"does not exist", and `npm run build` together. Every matched path is further checked for credibility: a bare module specifier, a path through `node_modules`, a path outside the repo root, or a path whose `dist/` directory already exists on disk (a different, unrelated file is missing from an already-built `dist/`) is rejected, and a matched line is only trusted when it looks like Node/npm's own error output (never a test runner's code frame echoing that text as quoted source). An npm-workspaces monorepo's fan-out output is split and classified **per workspace**: the check only downgrades when EVERY workspace that actually failed is, on its own, build-required; one unrelated, genuinely broken workspace in the same run keeps the whole check a blocking `fail`, never hidden behind another workspace's build-required evidence. The remedy in the skip message depends on what could actually fix it (the repo's own `npm run build` and `--setup` when a root build script exists; a workspace-scoped `npm run build -w <name>`/`--workspaces --if-present` when only a workspace has one; a plain "no build script was found" otherwise), rather than always naming a command that might not exist. A match downgrades the check from `fail` to a named `skip` outcome carrying that remedy in its message, so `ready` is no longer blocked by it, EXCEPT when `--setup`'s own build step just failed or timed out preparing this same check, in which case the failure stays a blocking `fail` naming the build failure instead, since the repo genuinely does not build right now. A genuine failure with none of the evidence above (`tests/fixtures/monorepo-genuine-test-failure` is the negative control) stays a blocking `fail`, unchanged. Scored the same as any other `skip` (see `docs/confidence-scoring.md`): counted in the confidence denominator but not the numerator, plus the usual 0.03 `limitations` penalty; never scored as a `pass`. Scoped to the default auto-detected `npm run test` check only; a `commands.test` override in `.preflight.json` is not classified.

- **TDD counterpart checks now compare paths relative to `workingDir`.** Git
  diff paths were repository-root-relative while discovered tests were
  target-relative, producing false missing-test warnings for nested packages.
  The check now resolves the real git/worktree root, rebases changed sources
  into the evaluated target, and excludes sibling paths by directory segment.

## [0.5.0] - 2026-09-04

### Added

- **AWS credential detection, round 2 boundaries and coverage** (agent-tasks 9ef05069, fix-round and R2 review). The AWS access-key-ID prefix set was widened from `AKIA` alone to `AKIA`/`ASIA`/`ABIA`/`ACCA`/`A3T[A-Z0-9]` (matching gitleaks/detect-secrets), and the secret-value patterns gained identifier variants (`secretAccessKey`, `secret_access_key`, `aws_secret_key`, bare `secret_key`) plus a quoted-key fix for generic `api_key`/`token`/`secret`/`password` assignments. This fix-round pins the review-round boundaries: every 40-char-value pattern now end-anchors consistently so a longer session token/JWT sharing the first 40 characters is not misread as a 40-char AWS secret; the bare `secret_key` alternative now requires a standalone identifier boundary that permits leading hyphens (CLI flag / YAML dash forms `--secret-key=`, `-secret_key:` are detected) while blocking underscore-suffixed env-var cases (`MY_SECRET_KEY`/`jwt_secret_key` do not match — that broader identifier family is out of scope for an AWS-named pattern); and the quoted-key generic patterns' known false-positive class against JSON/YAML fixtures (OpenAPI specs, Postman collections, recorded HTTP responses) is documented in code and pinned by tests rather than exempted, with `secretAllowlist` / `pragma: allowlist secret` remaining the escape hatch. See `src/checks/secrets.ts` for the full per-decision rationale.

### Fixed

- **`npm audit` in the audit check is now bounded, and an audit that did not answer is reported as `skip`, not `warn`**. The npm branch of `runAuditChecks` (`src/checks/audit.ts`) previously ran `npm audit --json` with no timeout and read only its exit code and `metadata.vulnerabilities`, so a registry advisory-endpoint outage could hang the whole preflight run and, once it did return, was misread as `warn` (a non-zero exit with zero counts) rather than as "not evaluated". The npm call now goes through an exported `npmAuditRunner` object with a 90s timeout, and its result is classified in a fixed order: a parsed report carrying `metadata.vulnerabilities` is judged purely on its own counts (`pass`/`fail`/`warn`) whatever else npm printed, even for a run that was killed at the timeout after writing it; a timeout with no parsable report is `skip`; exit 0 without such a report stays `pass`; and a non-zero exit without such a report means the audit did not answer, which is `skip` with a message naming the cause and one `limitations` entry. `ready` is unaffected, and a skipped check is not counted toward confidence the way a `pass` is.

  The direction of that last rule is deliberate, and is the substance of this change: registry-side failures are **not** enumerated. npm's output for an unreachable or failing registry carries no `error.code` at all (the reason sits in a top-level `message`, `error.summary`/`error.detail` are empty, and an HTTP-status answer adds a top-level `statusCode`), and its exact shape varies with the transport failure and with the npm version, so any list of codes or message fragments silently misclassifies whatever it failed to anticipate. Earlier attempts at such a list produced both failure modes in turn: matching outage markers anywhere in the output turned real findings into `skip` (fail-open), and splitting error envelopes by `error.code` turned every real registry outage into `warn "unknown error"` (fail-shut). Only the other side of the split is enumerable, so only it is enumerated: an `error.code` of `ENOLOCK`, `EUSAGE`, `EAUDITNOPJSON`, `EAUDITNOLOCK`, `ENOAUDIT`, `EJSONPARSE`, `ENOENT`, `EACCES`, `EPERM` or `ENOTDIR` is npm refusing to run the audit locally, and stays a `warn` naming that failure (a repo with no lockfile, the normal case for a yarn/pnpm repo or one not yet installed, is unchanged). Everything else on a non-zero exit without a report degrades to "we did not learn anything" instead of to a fabricated finding. The cause text in the message and the limitation is npm's own: the payload's top-level `message`, else the envelope's summary or code, else the marker-bearing stderr line, else the exit code. Markers are only ever used to pick that text, never to decide an outcome.

  `npmAuditRunner` is a documented test seam: the test suite spies on it instead of shelling out to the real registry, and CI's `npm ci` now runs with `--no-audit --no-fund` so its own implicit audit no longer depends on registry reachability either. `tests/audit.test.ts` replays recorded real `npm audit --json` failure payloads (a refused connection, an unresolvable registry host, and a registry answering HTTP 503, across two npm majors whose advisory endpoint paths differ) rather than hand-written approximations, alongside negative controls that pin each boundary: a real finding whose stderr carries a network-errno warning stays `fail`, a marker token inside the report body stays `fail`, a clean exit-0 report with a stderr retry warning stays `pass`, exit 0 with empty or non-JSON output stays `pass`, an errno-shaped `error.code` is `skip`, and a local usage code is `warn`.

## [0.4.1] - 2026-08-20

### Fixed

- **`loadConfig()` no longer crashes the CLI on a malformed `.preflight.json` field** (task 850903cb). `JSON.parse(raw) as Partial<PreflightConfig>` previously trusted the parsed shape with no runtime check, so e.g. `logDir: 123` reached `expandLeadingTilde()`/`path.isAbsolute()` in `runner.ts` and threw `TypeError: value.startsWith is not a function`, crashing the whole run. `src/config.ts` now hand-rolls a field-by-field type check (no schema library) covering every `PreflightConfig` field: a field whose value has the wrong type is dropped (falls back to `defaultConfig()`'s value via the existing `mergeConfig` merge) and reported via `console.warn`, instead of being merged in as-is. Nested objects (`checks`, `setup`, `commands`, `sandbox`) are validated sub-field-by-sub-field so one malformed sibling doesn't drop the whole object; `customChecks[]` entries are validated individually so one malformed entry is dropped without discarding the rest of the array. A top-level JSON value that isn't even a plain object (array, string, etc.) invalidates the whole file. Valid configs are unaffected: every field that already matches its declared type passes through exactly as before. The new `validateConfig()` and `ConfigValidationResult` are exported from `src/config.ts`. **Fix-round (review of task 850903cb):** `checks.secretDetection`/`checks.ciSimulation` are now validated the same boolean-or-object way as every other `checks.*` toggle instead of being dropped when object-shaped (dropping them had made a `checks.secretDetection: { acknowledge: "..." }` in `.preflight.json` invisible to `runPreflight`, so the D-013 "not supported, use `secretAllowlist` instead" `limitations` entry, see `runner.ts#checkSecretDetectionAcknowledgeIgnored`, could never actually fire from a config FILE, only from a config built programmatically); it is reachable again. An unrecognized key, at the top level or inside `checks`/`commands`/`sandbox`/`setup`, is now warned about by name (e.g. a typo'd `"chekcs"`) instead of being silently dropped with no signal at all; still warn-only, never a reject, so a config written for a newer version of this field set still loads under an older one.

## [0.4.0] - 2026-08-18

### Added

- **MCP server (`preflight-mcp`)** (task 91953eae). `src/mcp.ts` / `dist/mcp.js`, stdio only, registered via `claude mcp add preflight -- preflight-mcp`. Exposes `preflight_run({ repoPath, ciSimulation?, noAudit?, noSecrets? })` and `preflight_batch({ root, only?, exclude?, noAudit?, noSecrets? })`, calling `runPreflight`/`runBatch` directly (no CLI shelling) and returning the exact structured JSON `preflight run --json` / `preflight batch --json` produce. Both tool descriptions carry two pinned warnings: the existing "`ready:false` means this PR will likely break CI; do not merge" guidance, and (fix-round finding, review of PR for task 91953eae) that the target repo's `.preflight.json` can define shell commands (`customChecks[].command`, `commands.lint`/`typecheck`/`test`/`audit`) these tools will execute — only point them at trusted repositories. A `repoPath`/`root` that doesn't exist, or exists but isn't a directory, returns a structured tool error instead of crashing or leaking a raw `ENOTDIR`. Both tools send periodic `notifications/progress` pings (~10s) while a check is still running, for clients that attached a `progressToken` (e.g. via an `onprogress` callback) — surviving the MCP SDK's 60s default request timeout on a long `preflight_run`/`preflight_batch` additionally requires the client to pass `resetTimeoutOnProgress: true` (or a raised timeout), a separate switch from just attaching the token; see README "MCP server" for details.
- **`@modelcontextprotocol/sdk` accepted as a production dependency** (89 additional transitive packages, measured via a `package-lock.json` diff with/without the dependency), for the `preflight-mcp` stdio server above. Deliberate trade-off, not an oversight: the feature is stdio-only (no new attack surface beyond what `preflight run`/`preflight batch` already have on the CLI), `npm audit` is clean on the added tree, and it's consistent with this org's other MCP servers (e.g. `codebase-oracle`) already carrying the same dependency. Tracked by the normal CVE-Sweep process going forward, same as every other production dependency.
- **`PreflightConfig.logDir`** (task 016425e6, follow-up to the 0.3.0 fail-log feature / PR #45). Wired through every check runner that persists failure logs (lint, typecheck, test, audit, custom), so operators can override the default `~/.agent-preflight/logs` per repo via `.preflight.json`. A relative value resolves against the repo root, not `workingDir` and not `process.cwd()`; a leading `~/` expands to the home directory.
- **Secret-detection test-fixture downgrade** (agent-tasks b31065cc). A secret-shaped finding whose matched VALUE starts with `test-`/`test_`/`dummy-`/`dummy_`/`fake-`/`fake_`, and whose file lives under a directory literally named `test` or `tests`, is downgraded from `fail` to a non-blocking `warn` — even when the current change introduces it. Deliberately narrow on both axes (exact-segment directory match, value-anchored prefix) so a realistic secret is never masked; see the README's "Secret detection: obvious test-fixture values don't block" section.
- **`checks.<kind>.acknowledge`** (agent-tasks b31065cc). Any `checks.*` toggle except `ciSimulation`, `secretDetection`, and `custom` can be set to `{ "acknowledge": "<non-empty reason>" }` instead of `true`/`false`, downgrading a `fail` on that check kind to a non-blocking `acknowledged` status carrying the reason, visible in `checks[]`, `message`, and `limitations` (never in `blockers[]`/`warnings[]` — see "Deliberate boundaries" in the README). A missing/non-string `acknowledge` value is rejected, reported in `limitations`, and leaves the check blocking. See the README's "Waiving a permanently-failing check" section for the full contract.
- **AWS credential detection in secret-detection** (agent-tasks 211f559c). `SECRET_PATTERNS` had no AWS coverage at all, so a file containing an AWS access key ID plus an `AWS_SECRET_ACCESS_KEY` assignment passed with zero findings. Two patterns added: `AKIA[0-9A-Z]{16}` (an AWS access key ID's fixed shape, no surrounding keyword required — added to `HIGH_CONFIDENCE_PATTERNS` alongside the existing `ghp_...`/PEM entries, so it is never downgraded by the test-fixture heuristic), and an `AWS_SECRET_ACCESS_KEY`-style identifier (any `_`/`-`/camelCase separator, case-insensitive) assigned a 40-char base64-ish value, anchored to the identifier so it cannot fire on an arbitrary 40-char string with no AWS-shaped key name on the line. Deliberate decision: AWS's own canonical documentation example access key ID matches `AKIA[0-9A-Z]{16}` and is **not** exempted — same hard-line, no-exemption treatment the existing `ghp_...`/PEM patterns already get; use `secretAllowlist` or an inline `pragma: allowlist secret` comment for a deliberately-committed example. **Hardened in review (fix-round, agent-tasks 211f559c):** the `AKIA` pattern is now boundary-anchored (`(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])`) in both `SECRET_PATTERNS` and `HIGH_CONFIDENCE_PATTERNS`, so it no longer fires on `AKIA...` merely embedded inside a longer uppercase/digit run (e.g. a base32-style build hash); and the secret-access-key assignment pattern now allows an optional closing quote directly on the identifier, so a quoted-key serialization (`"aws_secret_access_key": "<value>"` in JSON or quoted YAML) is detected too, not just an unquoted `key: value`/`key = value` form.

### Changed

- **Fail-log hardening: pid in filename, name-key rotation sort, stricter failure-marker matching** (task 016425e6, follow-up to the 0.3.0 fail-log feature / PR #45). The persisted-failure-log filename now includes `process.pid` (`<check>-<epoch-ms>-<pid>-<sequence>.log`) so two different `preflight` processes failing the same check in the same millisecond no longer collide — the previous scheme was only collision-free within a single process. `rotateLogFiles` now sorts by the filename's own `(epochMs, pid, sequence)` key instead of `statSync` mtime, which is both deterministic (no more races with other tools touching mtimes) and avoids a stat syscall per log file. `FAILURE_LINE_PATTERN`'s bullet markers (`×`, `✗`, `❯`, `●`) now require trailing whitespace, narrowing accidental matches on glyphs glued to unrelated text; this only affects which lines are highlighted in the informational `details` array on an already-failing check; it never touches `ready`, `confidence`, or pass/fail status.
- **Legacy pre-pid log filenames (`<check>-<epoch-ms>-<sequence>.log`, written by agent-preflight <0.4.0) are drained by rotation again, not orphaned.** The stricter own-file pattern above stopped matching that older two-segment shape, so any log left over from before this change would sit in the directory forever instead of aging out through the normal 20-file cap. Rotation now also recognizes the legacy shape, sorting it in by a synthetic `[epochMs, 0, 0]` key alongside current-format files. This is a one-time drain: once a legacy file rotates out, nothing writes that shape again.
- **`OWN_LOG_FILE_PATTERN` / `LEGACY_LOG_FILE_PATTERN` now require a 13-plus-digit epoch group** (task 016425e6, fail-log hardening review). The prior width-unbounded `\d+` matched any dash-number-count shape, so a foreign file dropped into the log directory by another tool, e.g. `nginx-2026-08-17.log` or `backup-2026-08.log`, was misclassified as this feature's own and became eligible for silent deletion by rotation. Real `Date.now()` values are 13 digits for the lifetime of this feature, so the guard rejects short numeric groups like a calendar year or month while accepting every genuine epoch-ms timestamp.
- **Secret-detection test-fixture downgrade hardened against two false negatives found in review of agent-tasks b31065cc.** `TEST_FIXTURE_VALUE_PATTERN` is now anchored to the FIRST `:`/`=` in the matched text: the prior unanchored pattern searched the whole matched text for any separator followed by a fixture-looking prefix, so a value with an inner separator — e.g. `password = "db://u:S3cretPr0d:test-1"` — matched on the embedded `:test-` and was wrongly downgraded, masking a real password. Separately, a new `HIGH_CONFIDENCE_PATTERNS` subset (the `ghp_...` and `-----BEGIN ... PRIVATE KEY-----` shapes) is now re-checked against the full line after a match, forcing `testFixture: false` regardless of which (possibly weaker) `SECRET_PATTERNS` entry actually won and regardless of the matched value's own prefix — `SECRET_PATTERNS` is checked in order and `scanDir` stops at the first match per line, so e.g. `TOKEN = "test-ghp_<36 chars>"` under `tests/` previously matched the earlier, weaker `(?:secret|token)` pattern and never even reached the `ghp_` check, downgrading a real GitHub token dressed up with a `test-` prefix. `isTestPath` also now checks only directory segments (`relPath.split("/").slice(0, -1)`) instead of every path segment, so a file merely NAMED `tests` (e.g. `bin/tests`), rather than living under a `test`/`tests` directory, no longer qualifies.
- **`checks.secretDetection.acknowledge` no longer waives anything (Orchestrator decision D-013, review of agent-tasks b31065cc).** `secret-detection` is removed from the internal kind→config-key map the acknowledge mechanism uses, alongside `ciSimulation` and `custom` — unlike those other check kinds, one `acknowledge` reason would have blinded every *future* secret-detection finding for the run, not just the one an operator actually reviewed. `PreflightConfig.checks.secretDetection` is now a plain `boolean` (matching `ciSimulation`); a configured-but-now-inert `{ "acknowledge": ... }` is reported once in `limitations`, pointing at `secretAllowlist` / the inline `pragma: allowlist secret` comment as the finding-scoped alternative, instead of being silently ignored.
- **`preflight batch`'s pretty output now flags acknowledged checks.** Acknowledged checks never appear in `blockers[]`/`warnings[]`, and batch's one-line-per-repo summary previously showed nothing to indicate a waiver was in play. A repo's line now appends `[n acknowledged]` when it has one or more acknowledged checks. The `agent-preflight`-named skill template (`templates/skills/agent-preflight/SKILL.md`) now also instructs consumers to scan `checks[]` for `status: "acknowledged"` and report it alongside blockers/warnings, rather than only quoting `blockers`/`warnings`.
- **A rejected `checks.<kind>.acknowledge` is now reported once per config key, not once per underlying `CheckResult`.** A config key such as `test` can back several results (one per `commands.test` entry); the rejection message previously embedded the individual check's name, so a malformed acknowledge on a multi-command check kind produced one near-duplicate `limitations` line per command instead of one.

### Fixed

- **Test suite no longer writes into the real `~/.agent-preflight/logs`** (task 086ac782, follow-up to the `PreflightConfig.logDir` rollout above). `tests/integration/critical-path.test.ts` (6 call sites, real `npx tsc` failing on a fixture with no local TypeScript), `tests/workspace.test.ts` (2 call sites, deliberately broken nested `npm run lint`/`test`), and the remaining uncovered `runShellCheck()` calls in `tests/runShellCheck.test.ts` (7 call sites) were spawning real failing shell commands without overriding `ShellCheckOptions.logDir`/`PreflightConfig.logDir`, so every full suite run wrote 12 real files into the operator's actual home directory, contradicting the `logDir` docblock ("Tests MUST override this to a temp directory"). All 15 call sites now route to a temp directory nested inside each test's own fixture repo path, cleaned up by the existing `afterAll`. Added a Vitest `globalSetup` (`tests/setup/no-real-home-writes.globalSetup.ts`) that snapshots the real log directory before the run and fails the whole run (verified via a grep-checked mutation probe: removing a `logDir` override reliably turns the run red) if any test writes into it during the run, structurally guarding against this class regressing.

## [0.3.0] - 2026-07-18

### Added

- **Failing shell checks now persist their full stdout+stderr to a log file and lead `details` with parsed failure lines** (PR #45). A failing `runShellCheck` (both the non-zero-exit branch and the timeout/error catch branch) previously truncated `details` to the raw first 10 output lines, discarding the rest — no consumer could recover a failing test's name or the full log, which is exactly the useless one-line diagnosis harness#356 hit on `npm-test`. The complete interleaved output is now written best-effort to `<logDir>/<check>-<epoch-ms>-<sequence>.log` (default `~/.agent-preflight/logs`, injectable per call via the new `ShellCheckOptions.logDir`; a per-process sequence number keeps same-millisecond failures of the same check from colliding), and `details` now lead with `full output: <path>` followed by up to 10 parsed vitest/jest failure lines (`FAIL `, `×`, `✗`, `❯`, `●` markers). When no marker matches or the log write fails, `details` falls back to the previous first-10-lines behavior, so a logging failure can never mask or alter the check's own result. Only the 20 newest logs matching this feature's own `-<epoch-ms>-<sequence>.log` naming are kept (`rotateLogFiles`); files any other tool drops into the same directory are never touched. The pass path, limitation classification, timeout handling, and exit-code semantics are unchanged.

### Fixed

- **Two pre-existing macOS-only failures in `profiles.test.ts`** (PR #45). `does not run setup steps unless explicitly enabled` relied on a bare failing `[[ -f ... ]]` propagating through `set -e` in its fake-npm fixture; bash 3.2.57 (macOS system bash) does not terminate on that construct, so the fixture fell through to exit 0 and the check reported a false pass. `resolves workingDir before running checks` compared the child's reported cwd against the literal `os.tmpdir()` path, which macOS resolves through the `/var` → `/private/var` symlink, so the string comparison always failed. Both fixes are test-only and behavior-preserving (Linux CI was already green); their absence had left this repo's own `preflight` gate reporting `not ready` on a spurious `npm-test` failure.

### Docs

- README documents the new `~/.agent-preflight/logs` persisted-failure-log side effect and its keep-last-20 rotation (PR #45).

## [0.2.1] - 2026-06-09

Security release closing the 2026-05-30 audit findings. The headline is a fail-closed fix to preflight's own audit and secret checks: high-severity CVEs and several secret patterns were silently downgraded to warnings. No new features (the solution-acceptance gate explored in PR #34 was reverted in PR #35 and is not part of this release).

### Fixed

- **`npm-audit` now fails on HIGH-severity CVEs, not just critical** (PR #36). The check counted only the `critical` bucket, so HIGH CVEs were downgraded to a non-blocking warning even though `npm audit` exits non-zero, contradicting the documented contract in `docs/checks.md` (audit fails on high-severity findings). It now reads the `high` bucket too and fails when `critical + high` is non-zero. The parse-failure path is preserved: a registry or parse error leaves both counts at 0 and stays a warning.
- **Secret detection closes three gaps** (PR #38). The line-wide negative lookaheads are dropped from `SECRET_PATTERNS`, so a trailing `example` / `here` / `todo` no longer suppresses a real secret (placeholder filtering stays scoped to the matched value via `PLACEHOLDER_PATTERNS`). The diff-base invocation gains `--relative` so diff paths line up with findings when run from a subdirectory (previously findings were silently downgraded to warnings). The text-extension allowlist is inverted to a binary-extension denylist, so every non-binary file is scanned, including `.pem` / `.key` / `.crt` and extensionless `id_rsa`, with a 2 MiB size cap.
- **Neutral strict-mode wording for the secret-detection blocking message** (PR #33). The message hardcoded "introduced by this change", which is wrong under `secretDetectionStrict: true` where the blocking set also includes pre-existing findings in untouched files.

### Changed

- **Removed stale planforge / scaffoldkit bootstrap artifacts** (PR #37).

## [0.2.0] - 2026-05-20

### Changed

- **Secret detection is now git-aware: a hit blocks only when the secret can actually reach the remote** (agent-tasks 6c717d8d). Previously any pattern hit produced `status: "fail"` (a hard blocker) regardless of git status, so a gitignored `.env` holding real credentials — the normal, correct state — blocked preflight, and a secret in an unrelated pre-existing file blocked a change that never touched it. The check now classifies each finding: a file that is gitignored AND untracked, or a `.md` documentation file, or any finding when the directory is not a git repository, is reported as a non-blocking `warn`; only a tracked or untracked-but-not-ignored file (one that can be committed and pushed) is a `fail`. The gitignored-and-untracked set is resolved with a single `git check-ignore --stdin` call over the finding files — `check-ignore` without `--no-index` never lists a tracked file, so it returns exactly the "cannot leak via git" set. A genuine secret committed to a tracked source file still fails.
- **Secret detection is now diff-scoped: a committable finding blocks only when the current change introduced it** (agent-tasks 1b93636a). On top of the git-aware tiering above, a finding in a committable file is a `fail` only when the file was changed by the current branch — measured against the merge-base with the upstream / default branch, and including uncommitted working-tree edits and new untracked files. A secret in a tracked file the branch never touched is reported as a non-blocking `warn`: it is real and surfaced, but it is not this push's regression and should not block an unrelated change. When the merge-base cannot be resolved (orphan / detached branch, no upstream and no default branch) the check fails safe and treats every committable finding as blocking. The new `secretDetectionStrict: true` config opts out of diff-scoping entirely — every committable finding is a `fail` regardless of which branch touched it.

### Added

- **`secretAllowlist` in `.preflight.json` and inline `pragma: allowlist secret` comments** (agent-tasks 6c717d8d). Secret detection previously had no suppression path, so an intentional demo/example key could only be silenced by deleting it. `secretAllowlist` accepts repo-relative paths, `path:line` pairs, and `*`-globs; a finding matching any entry is dropped. Alternatively, a line carrying a `pragma: allowlist secret` comment (the detect-secrets convention, comment-style agnostic) is skipped. The scanner now reports findings as `path:line` so a specific line can be allowlisted.

## [0.1.2] - 2026-05-18

### Fixed

- **Secret detection no longer false-positives in framework build dirs.**
  Bundler output (Next.js, Nuxt, SvelteKit, Gatsby/Parcel cache,
  Turborepo cache) routinely contains hashed identifier strings that
  match the `secret/token` heuristic, blocking preflight on every
  project that has run `next build` / `npm run dev` locally. `SKIP_DIRS`
  now also excludes `.next`, `.nuxt`, `.svelte-kit`, `.cache`,
  `.parcel-cache`, `.turbo`. These are always gitignored and
  rebuildable, so a secret that only lives inside them never reaches
  the remote, which is the contract this gate is protecting. Two new
  test cases in `tests/secrets.test.ts` cover the skip (including a
  nested `apps/web/.next/...` case for recursion depth) plus a
  mirror-image source control that asserts the same string in a non-
  skipped path still trips the detector.

## [0.1.1] - 2026-05-17

### Fixed

- **Wrapper-script "tool not installed" is now a limitation, not a fail**
  (PR #27). `npm run lint` / `npm run test` / `npm run typecheck` (and the
  analogous `composer run ...` invocations) previously surfaced as real
  blockers when the underlying tool (eslint, vitest, tsc, phpstan) was
  not installed, even though the missing toolchain is a setup issue and
  not a code issue. The new opt-in `treatToolNotFoundAsLimitation` on
  `runShellCheck` reclassifies these as limitations based on the specific
  shell error patterns (`: command not found`, `: Permission denied`);
  deliberate non-zero exits (including the existing workspace-script
  `exit 127` contract) remain real fails. Seven new test cases in
  `tests/runShellCheck.test.ts` cover the branches.

### Docs

- Open source surface added: LICENSE, CODE_OF_CONDUCT, CONTRIBUTING,
  SECURITY, plus issue + PR templates (PR #26).
- README cross-links harness as the canonical hook-wiring consumer of
  agent-preflight (PR #25).
- `git-batch-cli` inspiration link redirected to its new home in
  `agent-dx` (PR #24).
- README "60-second hook" rewrite + supporting prose moved into `docs/`
  (PR #23).

## [0.1.0] - 2026-04-26

First public release. Pre-1.0: the configuration schema, CLI flags,
and JSON output shape are not yet stable; minor versions may break
compatibility until v1.0.0.

### Added

- **Hybrid local CI checks**: git state, lint, typecheck, test,
  dependency audit, secret detection, commits hygiene, runs in a
  few seconds against the working tree.
- **Confidence scoring** in JSON output for downstream agents to
  decide whether to proceed.
- **Optional `act`-based CI simulation** that dry-runs GitHub
  Actions workflows locally (`act --dryrun`) before pushing.
- **Sandbox installer** + release bundle pipeline. The
  `release-bundle` Make target produces tarballs + SHA256 checksums
  that are attached to GitHub Releases by `release.yml`.
- **TDD check** that flags source files without a test counterpart
  (PR #15).
- **Monorepo workspace support**: when run at a workspace root,
  `typecheck`/`lint` falls through to root-level scripts (PR #18).
- **Git state hygiene checks** (clean-worktree + protected-branch).
- **PHP extension detection** in sandbox setup.
- **Skill templates** for downstream agents.

### Changed

- Single source of truth for the package version (`src/version.ts`,
  reads `package.json` at module-load). The pre-release shape
  hardcoded `.version("0.1.0")` directly into `src/cli.ts`; locked
  in by a vitest test that fails if any source file outside
  `version.ts` re-introduces a hardcoded literal.
- `runShellCheck` pre-checks the primary binary to prevent
  exit-127 misclassification (PR #19).

### Fixed

- Sandbox image entrypoint is now correct when invoked outside the
  workspace repo.
- Sandbox CI simulation + test execution stabilised across a range
  of project shapes.
- TDD tests configure git identity for CI compatibility (PR #16).
- ESLint warnings (no `any`, no unused vars) cleared across the
  codebase.

### Security

- `vitest 1.x → 4.1.2` to patch transitive `esbuild` and
  `brace-expansion` CVEs (PR #13).
- `vite` bumped to patch high-severity CVEs (PR #17).
- Dependabot scoped to security alerts only.

### Distribution

- npm package: `@lannguyensi/agent-preflight` (scoped; npm's
  typo-squatting protection blocks the unscoped name; binary stays
  `preflight`). This release is the first publish.
  Install with `npm install -g @lannguyensi/agent-preflight` or run
  via `npx @lannguyensi/agent-preflight`.
- GitHub Release bundles: `.tar.gz` source bundles with `.sha256`
  checksums for offline / air-gapped install.
- Docker image (Node 20 + Python + PHP + Java + `act` preinstalled)
  via the bundled `Dockerfile`.
