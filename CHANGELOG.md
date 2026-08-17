# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`PreflightConfig.logDir`** (task 016425e6, follow-up to the 0.3.0 fail-log feature / PR #45). Wired through every check runner that persists failure logs (lint, typecheck, test, audit, custom), so operators can override the default `~/.agent-preflight/logs` per repo via `.preflight.json`. A relative value resolves against the repo root, not `workingDir` and not `process.cwd()`; a leading `~/` expands to the home directory.

### Changed

- **Fail-log hardening: pid in filename, name-key rotation sort, stricter failure-marker matching** (task 016425e6, follow-up to the 0.3.0 fail-log feature / PR #45). The persisted-failure-log filename now includes `process.pid` (`<check>-<epoch-ms>-<pid>-<sequence>.log`) so two different `preflight` processes failing the same check in the same millisecond no longer collide — the previous scheme was only collision-free within a single process. `rotateLogFiles` now sorts by the filename's own `(epochMs, pid, sequence)` key instead of `statSync` mtime, which is both deterministic (no more races with other tools touching mtimes) and avoids a stat syscall per log file. `FAILURE_LINE_PATTERN`'s bullet markers (`×`, `✗`, `❯`, `●`) now require trailing whitespace, narrowing accidental matches on glyphs glued to unrelated text; this only affects which lines are highlighted in the informational `details` array on an already-failing check; it never touches `ready`, `confidence`, or pass/fail status.
- **Legacy pre-pid log filenames (`<check>-<epoch-ms>-<sequence>.log`, written by agent-preflight <0.4.0) are drained by rotation again, not orphaned.** The stricter own-file pattern above stopped matching that older two-segment shape, so any log left over from before this change would sit in the directory forever instead of aging out through the normal 20-file cap. Rotation now also recognizes the legacy shape, sorting it in by a synthetic `[epochMs, 0, 0]` key alongside current-format files. This is a one-time drain: once a legacy file rotates out, nothing writes that shape again.
- **`OWN_LOG_FILE_PATTERN` / `LEGACY_LOG_FILE_PATTERN` now require a 13-plus-digit epoch group** (task 016425e6, fail-log hardening review). The prior width-unbounded `\d+` matched any dash-number-count shape, so a foreign file dropped into the log directory by another tool, e.g. `nginx-2026-08-17.log` or `backup-2026-08.log`, was misclassified as this feature's own and became eligible for silent deletion by rotation. Real `Date.now()` values are 13 digits for the lifetime of this feature, so the guard rejects short numeric groups like a calendar year or month while accepting every genuine epoch-ms timestamp.

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
