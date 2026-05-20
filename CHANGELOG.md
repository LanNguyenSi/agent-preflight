# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Secret detection is now git-aware: a hit blocks only when the secret can actually reach the remote** (agent-tasks 6c717d8d). Previously any pattern hit produced `status: "fail"` (a hard blocker) regardless of git status, so a gitignored `.env` holding real credentials — the normal, correct state — blocked preflight, and a secret in an unrelated pre-existing file blocked a change that never touched it. The check now classifies each finding: a file that is gitignored AND untracked, or a `.md` documentation file, or any finding when the directory is not a git repository, is reported as a non-blocking `warn`; only a tracked or untracked-but-not-ignored file (one that can be committed and pushed) is a `fail`. The gitignored-and-untracked set is resolved with a single `git check-ignore --stdin` call over the finding files — `check-ignore` without `--no-index` never lists a tracked file, so it returns exactly the "cannot leak via git" set. A genuine secret committed to a tracked source file still fails.

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
- **Optional `act`-based CI simulation** that replays GitHub
  Actions workflows locally before pushing.
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
