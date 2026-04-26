# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-26

First public release. Pre-1.0: the configuration schema, CLI flags,
and JSON output shape are not yet stable; minor versions may break
compatibility until v1.0.0.

### Added

- **Hybrid local CI checks**: git state, lint, typecheck, test,
  dependency audit, secret detection, commits hygiene — runs in a
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

- npm package: `agent-preflight` (this release is the first publish).
  Install with `npm install -g agent-preflight` or run via
  `npx agent-preflight`.
- GitHub Release bundles: `.tar.gz` source bundles with `.sha256`
  checksums for offline / air-gapped install.
- Docker image (Node 20 + Python + PHP + Java + `act` preinstalled)
  via the bundled `Dockerfile`.
