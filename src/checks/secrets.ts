import fs from "fs";
import path from "path";
import { execa } from "execa";
import { CheckResult, PreflightConfig } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

// NOTE: no line-wide `(?!.*(?:...))` negative lookahead here. A trailing
// "example"/"here"/"todo" anywhere on the line must NOT suppress a real
// secret earlier on it (that lookahead was a scanner bypass). Example /
// placeholder values are instead filtered by the value-scoped
// PLACEHOLDER_PATTERNS check against the *matched text* in scanDir, plus
// the diff-scoped / `.md` / gitignored severity tiering.
const SECRET_PATTERNS = [
  // Quoted-key blind spot (fix-round, agent-tasks 9ef05069, mirrors the
  // AWS assignment pattern's F1 fix below): an optional `["']?` sits
  // directly after the identifier, on all three of these, so a
  // quoted-key serialization — `"api_key": "<value>"` in JSON, or
  // `'token': '<value>'` in quoted YAML/Python — is detected too.
  // Without it, the identifier had to be followed immediately by
  // `\s*[:=]` with nothing in between, which a quoted key never
  // satisfies (its own closing quote sits in that gap). Unquoted forms
  // (`apiKey = "<value>"`, a bare YAML `token: <value>`) are unaffected:
  // the `["']?` is optional and matches zero characters there.
  /(?:api[_-]?key|apikey)["']?\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}["']?/i,
  /(?:password|passwd|pwd)["']?\s*[:=]\s*["'][^"']{8,}["']/i,
  /(?:secret|token)["']?\s*[:=]\s*["'][a-zA-Z0-9_-]{20,}["']/i,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  // AWS access key ID: a fixed, unambiguous shape (`AKIA` + 16 uppercase
  // alphanumeric chars) — no surrounding keyword needed, same rationale
  // as the bare `ghp_...` entry above. Also listed in
  // HIGH_CONFIDENCE_PATTERNS below (agent-tasks 211f559c): the AWS docs'
  // own canonical example access-key-id ALSO matches this shape (see
  // tests/secrets.test.ts) and is deliberately NOT exempted — same
  // hard-line, no-exemption treatment as a `ghp_...`/PEM match. A
  // canonical doc example pasted into a real file is exactly as likely
  // to be a copy-paste mistake as a genuine leaked key, and this scanner
  // has no mechanism (nor should it grow one here) to distinguish
  // "someone's actual AWS key" from "someone quoted the docs' example
  // verbatim in the wrong place" — the `pragma: allowlist secret` /
  // `secretAllowlist` escape hatches already cover a deliberately-
  // committed example. (The literal example string is deliberately not
  // spelled out in this comment: it matches the pattern below and would
  // trip this very check when this file is self-scanned.)
  //
  // Boundary-anchored (fix-round, agent-tasks 211f559c review, finding
  // F2): a bare `(?<![A-Z0-9])`/`(?![A-Z0-9])` lookbehind/lookahead
  // stops this high-confidence, non-downgradable pattern from firing on
  // `AKIA...` merely embedded inside a longer uppercase/digit run (e.g.
  // a base32-style build hash or checksum) where it is not actually a
  // standalone AWS access key ID — such a false positive would
  // otherwise be a hard, non-downgradable block. Every genuine
  // standalone occurrence (quoted, in a URL query string, bare in
  // prose, ...) is bounded by a non-alphanumeric-or-different-case
  // character on both sides already, so this narrows nothing real; see
  // tests/secrets.test.ts.
  //
  // Prefix alternation widened (round 2, agent-tasks 9ef05069, R1
  // reviewer probe of 211f559c): AKIA alone missed AWS's other 20-char
  // access-key-ID-shaped credential prefixes. Decision per prefix
  // (matches the well-known gitleaks/detect-secrets AWS-key regex,
  // which uses this same four-prefix-plus-A3T set):
  //   - ASIA (STS temporary/session credentials): included. Same
  //     20-char `PREFIX + 16 [0-9A-Z]` shape as AKIA, same
  //     false-positive reasoning, and a *more* urgent leak than a
  //     long-lived AKIA key since it is minted from an active
  //     assume-role session — the combined aws-sts-assume-role fixture
  //     below is exactly this case.
  //   - ABIA (AWS STS service bearer token, e.g. CodeArtifact) and ACCA
  //     (context-specific / imported credentials): included. Both are
  //     genuine AWS-issued bearer-credential prefixes with the identical
  //     fixed 20-char shape — no keyword needed, same as AKIA/ASIA — so
  //     the false-positive argument is unchanged: nothing else in
  //     practice produces `ABIA`/`ACCA` followed by exactly 16
  //     uppercase-alphanumeric characters.
  //   - A3T (legacy S3 access-grant / account-ID-shaped credential
  //     prefix): included via `A3T[A-Z0-9]` (3 fixed chars + 1 free
  //     char, so the alternative is 4 chars wide like the others,
  //     20 total with the shared 16-char tail) for the same reason.
  //   - AIDA/AROA/AGPA/ANPA/ANVA (IAM user/role/group/policy/certificate
  //     resource IDs) are deliberately NOT included: these identify an
  //     IAM *resource*, not a bearer credential — leaking one names an
  //     entity but grants no access on its own, so it does not belong
  //     in a secret-detection pattern (a resource-ID leak is a
  //     different, weaker risk class than a credential leak).
  /(?<![A-Z0-9])(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])/,
  // AWS secret access key: an AWS_SECRET_ACCESS_KEY-style identifier
  // (aws/secret/access/key in order, any `_`/`-`/camelCase separator,
  // case-insensitive) assigned a 40-char base64-ish value, with an
  // optional closing quote allowed directly on the identifier itself
  // (fix-round, agent-tasks 211f559c review, finding F1) so a
  // quoted-key serialization — `"aws_secret_access_key": "<value>"` in
  // JSON or quoted YAML — is detected too; without it, the identifier
  // had to be followed immediately by `\s*[:=]` with nothing in
  // between, which quoted-key forms never satisfy. Anchored to the
  // identifier — not just "any 40-char base64-ish string" — so it
  // cannot fire on an arbitrary hash/token with no AWS-shaped key name
  // on the line. Not in HIGH_CONFIDENCE_PATTERNS: unlike AKIA's fixed
  // prefix, a 40-char base64-ish value has no shape of its own that is
  // unambiguously AWS-specific.
  //
  // NOTE (fix-round, agent-tasks 211f559c review, finding F3): despite
  // the framing above, this pattern does NOT actually reach the
  // test-fixture downgrade in practice. TEST_FIXTURE_VALUE_PATTERN
  // requires `test`/`dummy`/`fake` immediately followed by `-`/`_`
  // right after the first `:`/`=`; this pattern's value charset is
  // `[A-Za-z0-9/+=]` — no `-` and no `_` — so a matched value can never
  // start with `test-`, `test_`, `dummy-`, `dummy_`, `fake-`, or
  // `fake_`. The downgrade path is therefore structurally unreachable
  // for this pattern as currently written (locked by a test in
  // tests/secrets.test.ts). Widening the value charset to include `-`
  // or `_` would make it reachable again — do that deliberately, not by
  // accident.
  /aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  // AWS secret access key, round 2 (agent-tasks 9ef05069, R1 reviewer
  // probe of 211f559c): the pattern above requires the literal word
  // "aws" in the identifier and misses the same credential under the
  // identifier names real AWS SDKs/tools actually emit without it —
  // `secretAccessKey` (AWS JS SDK's own field name, e.g. in an
  // `aws sts assume-role` JSON response's `Credentials` block) and
  // `secret_access_key` (boto/AWS CLI config). `(?:aws[_-]?)?` makes the
  // "aws" prefix optional instead of duplicating the whole pattern, so
  // this one alternative also still matches every form the pattern
  // above matches. Same anchoring rationale as above: still requires
  // the full "secret ... access ... key" identifier, still not in
  // HIGH_CONFIDENCE_PATTERNS (the value shape alone is not
  // AWS-specific). Adds `(?![A-Za-z0-9/+=])` right after the 40-char
  // value (a value-shape tightening this round-2 pattern introduces
  // fresh, not present on the pattern above): without it, `{40}` finds
  // any 40-char run as a PREFIX of a longer base64-ish value too — a
  // 200-char JWT or session token beginning with 40 charset-compatible
  // characters would false-positive as a 40-char AWS secret key. The
  // lookahead requires the value to actually END at 40 characters.
  /(?:aws[_-]?)?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])["']?/i,
  // AWS secret key, "no access" identifier variants (agent-tasks
  // 9ef05069): `aws_secret_key` (Ansible's `aws_secret_key` module
  // parameter) and bare `secret_key` (Terraform's conventional variable
  // name for this same credential) both drop the word "access" from the
  // identifier entirely. `secret[_-]?key` alone (no "access", no "aws")
  // is a BROAD identifier — Django's `SECRET_KEY`, a Stripe
  // `secret_key`/API key, a generic app signing key, etc. all use it —
  // so per review-round constraint this is deliberately gated on the
  // exact same 40-char-base64-ish, exactly-bounded value shape as the
  // two patterns above (not added as a bare keyword match, and not
  // added to HIGH_CONFIDENCE_PATTERNS). Residual false-positive
  // reasoning for why this is still an acceptable risk at that value
  // shape: Django's default `SECRET_KEY` generator draws from a ~70-char
  // alphabet that includes `!@#$%^&*(-_=+)` — most of which (`!@#$%^&*(`
  // plus the frequently-used `-`/`_`) fall OUTSIDE this pattern's
  // `[A-Za-z0-9/+=]` charset, so a real Django-generated value breaks
  // the match within the first few characters far more often than not;
  // Stripe secret keys are `sk_live_`/`sk_test_`-prefixed and the
  // underscores after `sk` break the charset-run immediately too. The
  // residual case — an app's custom "secret key" happens to be exactly
  // 40 chars of `[A-Za-z0-9/+=]` with no separator — is accepted as the
  // same class of risk the pattern above already carries for
  // `secret_access_key`, not a new one; see
  // tests/secrets.test.ts for the Django-shaped negative control.
  /(?:aws[_-]?)?secret[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])["']?/i,
];

// High-confidence secret SHAPES (review finding 2, fix-round on agent-tasks
// b31065cc): a match against either of these anywhere on the line means the
// line unambiguously carries a real credential format, not just a
// name-looks-like-a-secret heuristic. SECRET_PATTERNS above is checked in
// order and scanDir stops at the FIRST pattern that matches a given line
// (see the `break` there), so a line such as
// `TOKEN = "test-ghp_<36 chars>"` trips the earlier, weaker
// `(?:secret|token)\s*[:=]...` pattern first and — pre-fix — the genuinely
// high-confidence `ghp_...` pattern a few lines below it was never even
// consulted for that line. scanDir re-tests the full line (not just the
// winning pattern's matched text) against this subset after a match is
// found, and forces `testFixture: false` whenever one hits — regardless of
// which SECRET_PATTERNS entry actually produced the finding, and regardless
// of whether the matched VALUE also happens to look test-/dummy-/fake-
// prefixed. A real ghp_ token or private-key header can be dressed up with
// a `test-` prefix exactly as easily as a real password can embed an inner
// `:test-` in a connection string (see TEST_FIXTURE_VALUE_PATTERN below) —
// in both cases the presence of an unambiguous credential SHAPE must win
// over the test-fixture heuristic, never the other way round.
const HIGH_CONFIDENCE_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  // AWS access key ID (agent-tasks 211f559c): see the SECRET_PATTERNS
  // entry above for the full rationale, including the deliberate
  // no-exemption decision for AWS's canonical example access-key-id and
  // the boundary-anchoring rationale (fix-round review, finding F2).
  // Prefix alternation (AKIA/ASIA/ABIA/ACCA/A3T) widened in lockstep
  // with the SECRET_PATTERNS entry, round 2, agent-tasks 9ef05069 — see
  // that entry for the per-prefix decision. Kept in
  // HIGH_CONFIDENCE_PATTERNS too: every one of these prefixes shares
  // AKIA's fixed, unambiguous 20-char shape, so the same
  // non-downgradable treatment applies to all of them, not just AKIA.
  /(?<![A-Z0-9])(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])/,
];

// Placeholder patterns that indicate example/template values (not real secrets)
const PLACEHOLDER_PATTERNS = [
  /your_[a-z_]+_here/i,
  /your_[a-z_]+_key/i,
  /example[_-]?key/i,
  /placeholder/i,
  /<your[_\s]/i,
];

// Test-fixture value heuristic (agent-tasks b31065cc): a secret-shaped
// finding whose VALUE (the text immediately after the `:`/`=` and an
// optional opening quote) starts with `test-`/`test_`/`dummy-`/`dummy_`/
// `fake-`/`fake_`, AND whose file lives under a directory literally named
// `test` or `tests` (see `isTestPath`), is downgraded to a non-blocking
// `warn` instead of `fail` — even when the current change introduces it.
// Real dogfood case: `TOKEN = "test-planforge-bot-token"` in  // pragma: allowlist secret
// scaffoldkit's tests/test_notify_planforge.py blocked a push for an
// obvious test constant.
//
// Deliberately narrow on BOTH axes, to avoid masking a real secret:
//   - Directory match is exact-segment ("test"/"tests"), not every
//     test-ish convention (no "__tests__", "spec", "e2e", ...) — widening
//     the path side widens how many files this can ever apply to.
//   - The prefix must be the VALUE itself, immediately after the
//     assignment, not merely present anywhere on the line — so
//     `token = "AbC-test-shaped-but-real-1234567890"` still blocks.  // pragma: allowlist secret
// A value that satisfies only one of the two conditions (a realistic
// secret inside tests/, or a test-/dummy-/fake-prefixed value outside any
// test/tests directory) still blocks exactly as before — see
// tests/secrets.test.ts's negative-control cases.
//
// Anchored to the FIRST `:`/`=` on the matched text (review finding 1,
// fix-round on agent-tasks b31065cc): `^[^:=]*[:=]` consumes everything up
// to and including that first separator (the key name), and the
// test-/dummy-/fake- prefix must sit immediately after it. The prior
// unanchored `/[:=]\s*.../ ` searched the ENTIRE matched text (which can be
// a whole line for the password/apiKey/secret patterns above) for ANY
// `:`/`=` followed by a fixture-looking prefix, so a value with an inner
// separator — e.g. `password = "db://u:S3cretPr0d:test-1"` — matched on  // pragma: allowlist secret
// the embedded `:test-` and got downgraded to `warn`, masking a real
// leaked password. Anchoring to the first separator means only the actual
// assigned value is examined, exactly as the block comment above already
// promises ("the prefix must be the VALUE itself, immediately after the
// assignment").
const TEST_FIXTURE_VALUE_PATTERN = /^[^:=]*[:=]\s*["']?(?:test|dummy|fake)[-_]/i;

// Only DIRECTORY segments count (review finding, fix-round on agent-tasks
// b31065cc): `.slice(0, -1)` drops the last segment, which is always the
// file's own basename, before checking for an exact "test"/"tests"
// segment. Without the slice, a FILE literally named `tests` (e.g.
// `bin/tests`, an extensionless script) counted as being "under a test
// directory" purely because its own filename matched — even though it
// lives directly in `bin/`, not in any `test`/`tests` directory.
function isTestPath(relPath: string): boolean {
  return relPath.split("/").slice(0, -1).some((segment) => {
    const lower = segment.toLowerCase();
    return lower === "test" || lower === "tests";
  });
}

// Inline suppression marker (the detect-secrets convention). Comment-style
// agnostic: `# pragma: allowlist secret`, `// pragma: allowlist secret`,
// `<!-- pragma: allowlist secret -->` all work — the line just has to
// contain the phrase. A line carrying it is skipped entirely.
const ALLOWLIST_PRAGMA = /pragma:\s*allowlist\s+secret/i;

const IGNORE_FILES = [
  ".env.example", ".env.sample", ".env.template", ".env.*.example", "*.test.ts", "*.spec.ts",
];

// Framework build / cache dirs (added 2026-05-18): bundlers emit hashed
// identifiers that match the SECRET_PATTERNS heuristics (notably
// `secret/token = "<long hash>"`), producing false positives that block
// preflight on every Next.js / Nuxt / SvelteKit / Gatsby / Parcel /
// Turborepo project. These dirs are always gitignored and rebuildable,
// so a secret that only lives inside them never reaches the remote —
// which is the contract this gate is protecting. (A `NEXT_PUBLIC_*` or
// SvelteKit `PUBLIC_*` value baked into a bundle is a separate concern,
// not a leak prevented by detecting it in the gitignored build output.)
// `.cache` is intentionally broad — Gatsby, Parcel, Hugo, and various
// per-tool caches all live there; all are rebuildable.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".venv", "venv", "test_venv", "env",
  "__pycache__", "vendor", "site-packages", ".tox", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".cache", ".parcel-cache", ".turbo",
]);

interface Finding {
  /** Repo-root-relative path, always forward-slash separated. */
  file: string;
  /** 1-based line number of the matching line. */
  line: number;
  /**
   * Set at scan time when both TEST_FIXTURE_VALUE_PATTERN and isTestPath
   * matched (see the block comment above those). A test-fixture finding is
   * always downgraded to `warn`, regardless of diff scope or
   * secretDetectionStrict — the same unconditional tier as a `.md` hit or
   * a gitignored-untracked file.
   */
  testFixture: boolean;
}

/**
 * Secret detection with git-aware, diff-scoped severity (agent-tasks
 * 6c717d8d + 1b93636a). A finding is a hard blocker (`fail`) only when
 * the secret can actually reach the remote AND belongs to the change
 * being pushed:
 *
 *   - Not a git repository (or git unavailable): the git→remote leak
 *     model does not apply, so every finding is a non-blocking `warn`.
 *   - A `.md` file: documentation example tokens are overwhelmingly
 *     placeholders, so a hit there is `warn`, never `fail`.
 *   - A file that is gitignored AND untracked: it cannot be pushed, so
 *     `warn`. (`git check-ignore` without `--no-index` reports exactly
 *     this set — a tracked file is never listed even if a rule matches.)
 *   - An obvious test-fixture constant: the matched value itself starts
 *     with `test-`/`test_`/`dummy-`/`dummy_`/`fake-`/`fake_` AND the file
 *     lives under a directory literally named `test` or `tests`: `warn`.
 *     See the TEST_FIXTURE_VALUE_PATTERN/isTestPath block comment above
 *     for why both conditions are required and kept narrow.
 *   - A committable file (tracked, or untracked-but-not-ignored) that
 *     the current branch CHANGED — relative to its merge-base with the
 *     default/upstream branch, plus working-tree edits and new untracked
 *     files: `fail`. This is a secret the current push introduces.
 *   - A committable file the current branch did NOT touch: `warn`. The
 *     secret is pre-existing and real, but it is not this push's
 *     regression, so it should not block an unrelated change.
 *
 * `config.secretDetectionStrict: true` opts out of the diff-scoping —
 * every committable finding is `fail` regardless of whether the branch
 * touched it. The same strict behaviour is the fail-safe fallback when
 * the merge-base cannot be resolved (detached/orphan branch, no
 * upstream and no default branch), so a finding is never silently
 * downgraded on an inconclusive diff. The test-fixture rule above is a
 * separate, unconditional axis (same tier as `.md` / gitignored-untracked)
 * and still applies under `secretDetectionStrict` — strict mode only
 * removes the diff-scoping leniency, not the "this obviously isn't a real
 * secret" classification.
 *
 * Findings matching `config.secretAllowlist` or carrying an inline
 * `pragma: allowlist secret` comment are suppressed entirely.
 */
export async function runSecretDetection(
  repoPath: string,
  config: PreflightConfig = {},
): Promise<CheckSetResult> {
  const start = Date.now();
  const rawFindings: Finding[] = [];
  const limitations: string[] = ["secret detection uses pattern matching; not exhaustive"];

  scanDir(repoPath, repoPath, rawFindings);

  const allowlist = config.secretAllowlist ?? [];
  const findings = rawFindings.filter((f) => !matchesAllowlist(f, allowlist));

  // `git check-ignore` over just the finding files (not the whole tree).
  const uniqueFiles = [...new Set(findings.map((f) => f.file))];
  const { gitAvailable, ignoredUntracked } = await classifyIgnored(repoPath, uniqueFiles);
  if (findings.length > 0 && !gitAvailable) {
    limitations.push(
      "secret-detection: not a git repository (or git unavailable); findings reported as non-blocking warnings",
    );
  }

  // Diff scope: the set of files the current branch changed (vs. its
  // merge-base with the default/upstream branch) plus new untracked
  // files. `null` means the base could not be resolved — the caller
  // then fails safe by treating every committable finding as blocking.
  const strict = config.secretDetectionStrict === true;
  let changedFiles: Set<string> | null = null;
  if (gitAvailable && !strict && findings.length > 0) {
    changedFiles = await resolveChangedFiles(repoPath);
    if (changedFiles === null) {
      limitations.push(
        "secret-detection: could not resolve a diff base; every committable finding treated as blocking",
      );
    }
  }

  const blocking: Finding[] = [];
  const warning: Finding[] = [];
  for (const f of findings) {
    if (!gitAvailable) {
      warning.push(f);
    } else if (f.file.toLowerCase().endsWith(".md")) {
      warning.push(f);
    } else if (ignoredUntracked.has(f.file)) {
      warning.push(f);
    } else if (f.testFixture) {
      // Obvious test-fixture constant under a test/tests directory: never
      // a blocker, independent of diff scope or secretDetectionStrict.
      warning.push(f);
    } else if (strict || changedFiles === null || changedFiles.has(f.file)) {
      // Committable AND introduced/touched by this change (or strict
      // mode, or an inconclusive diff base): a secret this push adds.
      blocking.push(f);
    } else {
      // Committable but pre-existing — the current branch never touched
      // this file, so the secret is real but not this push's regression.
      warning.push(f);
    }
  }

  const status: CheckResult["status"] =
    blocking.length > 0 ? "fail" : warning.length > 0 ? "warn" : "pass";

  let message: string | undefined;
  if (blocking.length > 0) {
    // The diff-scoped "introduced by this change" wording is only honest
    // when every blocking finding sits in a file this branch changed.
    // Strict mode and an unresolved diff base (`changedFiles === null`)
    // both push pre-existing findings into `blocking`, so fall back to
    // neutral wording in those cases.
    const diffScoped = !strict && changedFiles !== null;
    message = diffScoped
      ? `${blocking.length} potential secret(s) introduced by this change`
      : `${blocking.length} potential secret(s) in committable file(s)`;
    if (warning.length > 0) {
      message += ` (+${warning.length} non-blocking)`;
    }
  } else if (warning.length > 0) {
    message = `${warning.length} potential secret(s) in non-blocking location(s) (pre-existing, gitignored, docs, test-fixture, or non-git)`;
  }

  const details = [
    ...blocking.map((f) => `${f.file}:${f.line}`),
    ...warning.map((f) => `${f.file}:${f.line} (non-blocking)`),
  ].slice(0, 10);

  return {
    checks: [{
      name: "secret-detection",
      kind: "secret-detection",
      status,
      message,
      details,
      durationMs: Date.now() - start,
      confidenceContribution: 0.1,
    }],
    limitations,
  };
}

/**
 * Resolve which of `relFiles` are gitignored-and-untracked. `git
 * check-ignore` (without `--no-index`) lists a path only when an ignore
 * rule excludes it AND it is not already in the index, which is exactly
 * the "cannot leak via git" set. A 128 exit (not a repo / fatal git
 * error) or a missing `git` binary yields `gitAvailable: false`, and the
 * caller then fails safe by treating every finding as blocking-eligible.
 */
async function classifyIgnored(
  repoPath: string,
  relFiles: string[],
): Promise<{ gitAvailable: boolean; ignoredUntracked: Set<string> }> {
  if (relFiles.length === 0) return { gitAvailable: true, ignoredUntracked: new Set() };
  try {
    const res = await execa("git", ["check-ignore", "--stdin"], {
      cwd: repoPath,
      input: relFiles.join("\n"),
      reject: false,
    });
    // 0 = at least one path ignored, 1 = none ignored — both are a
    // healthy repo. Anything else (128 = not a repo / fatal) is "unknown".
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      return { gitAvailable: false, ignoredUntracked: new Set() };
    }
    const ignored = new Set(
      res.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    );
    return { gitAvailable: true, ignoredUntracked: ignored };
  } catch {
    // git binary missing (ENOENT) or spawn failure.
    return { gitAvailable: false, ignoredUntracked: new Set() };
  }
}

/** Run a git command; return stdout on a clean exit, `null` on any failure. */
async function runGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const res = await execa("git", args, { cwd: repoPath, reject: false });
    return res.exitCode === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

interface DiffBaseCandidate {
  ref: string;
  /**
   * Whether `ref` is backed by actual remote-tracking configuration
   * (upstream, `origin/HEAD`, or a resolved `origin/*` branch) rather
   * than a blind local-branch-name guess. See the "not diverged" handling
   * below for why this distinction matters.
   *
   * Accepted residual: the upstream candidate (`@{u}`) is trusted on the
   * assumption that it normally reflects real remote state: a tracking
   * branch configured against `origin/...`. Git also allows `@{u}` to
   * resolve to a purely LOCAL branch (e.g. `branch.<name>.remote = "."`,
   * tracking a sibling local branch with no remote involved at all). In
   * that exotic configuration a secret committed to the tracked local
   * branch but never pushed anywhere could be downgraded from `fail` to
   * `warn` here, same as the "not diverged from the real default branch"
   * case this trust model is designed for. This is a known, accepted gap
   * rather than a defect: it requires a deliberately unusual tracking
   * setup, and `secretDetectionStrict` remains available to opt out of
   * diff-scoping entirely when that setup is in play.
   */
  trusted: boolean;
}

/**
 * Resolve the commit to diff the current branch against: the merge-base
 * with the upstream tracking branch, else `origin/HEAD`'s target, else a
 * common default branch. Returns the merge-base SHA, or `null` when none
 * resolves (orphan/detached branch, no upstream, no default branch) so
 * the caller can fail safe instead of scoping against nothing.
 *
 * A candidate whose merge-base equals HEAD means the branch has not
 * diverged from the ref (you are on the ref itself, or strictly behind
 * it). What that implies differs by candidate:
 *
 *   - A `trusted` candidate (upstream, `origin/HEAD`, or a resolved
 *     `origin/main`/`origin/master`) confirms, via actual remote-tracking
 *     state rather than a guess, that this really is the repo's default
 *     branch. No divergence there is meaningful: HEAD sits on the default
 *     branch with nothing committed beyond it, so the SHA (== HEAD) is
 *     returned as the base. `resolveChangedFiles` then diffs HEAD against
 *     the working tree, which correctly yields an empty set unless there
 *     are uncommitted edits (agent-tasks 1ba4a4d1: a freshly cloned repo
 *     sitting untouched on its default branch must not be scored as
 *     "diff base unresolvable").
 *   - An untrusted candidate (the bare local-branch-name fallback `main`
 *     or `master`) is skipped instead: with no remote-tracking
 *     confirmation, `mb === headSha` just as plausibly means "this branch
 *     happens to be named main/master and IS the ref" with no evidence it
 *     is actually anyone's default branch, e.g. a secret committed
 *     straight onto a local `main` with no upstream and no origin remote
 *     must stay a hard blocker, not be waved through as "unchanged".
 *
 * If every candidate is either unresolvable or an untrusted non-diverged
 * guess, `null` is returned so the caller fails safe.
 */
async function resolveDiffBase(repoPath: string): Promise<string | null> {
  const headSha = (await runGit(repoPath, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const candidates: DiffBaseCandidate[] = [];
  const upstream = await runGit(repoPath, [
    "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
  ]);
  if (upstream) candidates.push({ ref: upstream.trim(), trusted: true });
  const originHead = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead) candidates.push({ ref: originHead.trim(), trusted: true });
  candidates.push(
    { ref: "origin/main", trusted: true },
    { ref: "origin/master", trusted: true },
    { ref: "main", trusted: false },
    { ref: "master", trusted: false },
  );

  for (const { ref, trusted } of candidates) {
    if (!ref) continue;
    const mb = (await runGit(repoPath, ["merge-base", "HEAD", ref]))?.trim();
    if (!mb) continue;
    if (headSha !== null && mb === headSha && !trusted) continue; // unconfirmed guess: not real divergence signal
    return mb;
  }
  return null;
}

/**
 * The set of repo-relative paths the current branch has changed: tracked
 * files that differ from the merge-base (committed-on-branch edits AND
 * uncommitted working-tree edits, both captured by `git diff <base>`),
 * plus new untracked-and-unignored files. Paths are forward-slash
 * normalised to line up with `Finding.file`. `null` when the diff base
 * is unresolvable — the caller treats that as "scope unknown".
 */
async function resolveChangedFiles(repoPath: string): Promise<Set<string> | null> {
  const base = await resolveDiffBase(repoPath);
  if (base === null) return null;

  const changed = new Set<string>();
  // `git diff --name-only <base>` (no `..HEAD`) compares the base to the
  // working tree, so it covers both committed-on-branch and uncommitted
  // edits in one call. `-c core.quotePath=false` keeps non-ASCII paths
  // verbatim so they line up with `Finding.file`. `--relative` scopes the
  // output to `repoPath` (the working dir) and makes paths relative to it,
  // so when `repoPath` is a subdirectory of the git root the diff paths
  // line up with `Finding.file` and `ls-files --others` (both already
  // cwd-relative) instead of carrying a leading subdir prefix that would
  // never match and silently downgrade every finding to a warning.
  const diff = await runGit(repoPath, [
    "-c", "core.quotePath=false", "diff", "--name-only", "--relative", base,
  ]);
  if (diff === null) return null;
  for (const line of diff.split("\n")) {
    const p = line.trim();
    if (p) changed.add(p);
  }
  // New files not yet tracked (and not gitignored) are part of this change.
  const others = await runGit(repoPath, [
    "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard",
  ]);
  if (others !== null) {
    for (const line of others.split("\n")) {
      const p = line.trim();
      if (p) changed.add(p);
    }
  }
  return changed;
}

/**
 * Does a finding match an operator-supplied `secretAllowlist` entry?
 * An entry matches when it equals the finding's `path`, equals
 * `path:line`, or is a `*`-glob matching either. Allowlisted findings
 * are dropped before severity classification — the operator has
 * reviewed them.
 */
function matchesAllowlist(f: Finding, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const fileLine = `${f.file}:${f.line}`;
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (entry === f.file || entry === fileLine) return true;
    if (entry.includes("*")) {
      const re = globToRegExp(entry);
      if (re.test(f.file) || re.test(fileLine)) return true;
    }
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function scanDir(dir: string, root: string, findings: Finding[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // skip directories we can't read (permission denied etc.)
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, root, findings);
    } else if (entry.isFile() && isTextFile(entry.name) && !isIgnored(entry.name)) {
      let content: string;
      try {
        if (fs.statSync(fullPath).size > MAX_SCAN_BYTES) continue; // skip large blobs
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue; // ignore read errors
      }
      // forward-slash relative path so it lines up with `git check-ignore`
      // output and with operator-written allowlist entries.
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Inline suppression: a line carrying the pragma is skipped.
        if (ALLOWLIST_PRAGMA.test(line)) continue;
        for (const pattern of SECRET_PATTERNS) {
          const match = line.match(pattern);
          const matchText = match ? match[0] : "";
          if (match && !PLACEHOLDER_PATTERNS.some((p) => p.test(matchText))) {
            // A high-confidence credential SHAPE anywhere on the line (see
            // HIGH_CONFIDENCE_PATTERNS above) always wins over the
            // test-fixture heuristic, even when the winning SECRET_PATTERNS
            // entry above was a weaker one, and even when the matched
            // value also looks test-/dummy-/fake-prefixed.
            const highConfidence = HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(line));
            const testFixture =
              !highConfidence && isTestPath(relPath) && TEST_FIXTURE_VALUE_PATTERN.test(matchText);
            findings.push({ file: relPath, line: i + 1, testFixture });
            break; // one finding per line is enough
          }
        }
      }
    }
  }
}

// Known-binary / generated-artifact extensions we never scan. The scanner
// is a denylist, not an allowlist: every other file (including uncommon
// credential formats like .pem/.key/.crt/.pfx/.tf/.properties and
// extensionless keys such as id_rsa) is scanned, so a new credential
// format is covered by default instead of slipping through an allowlist
// gap. Scanning these binary blobs as UTF-8 only yields garbage + false
// positives, and credentials are not stored in them.
const SKIP_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svg",
  // archives / compressed
  "zip", "gz", "tar", "tgz", "bz2", "xz", "7z", "rar",
  // documents / media
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "mp4", "wav", "avi", "mov", "mkv", "webm", "ogg", "flac",
  // fonts
  "woff", "woff2", "ttf", "eot", "otf",
  // compiled / binary
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "jar", "war",
  "wasm", "node", "pyc", "pyo", "obj",
  // generated / data blobs
  "lock", "map", "db", "sqlite",
]);

// Skip very large files: they are almost always data/binary blobs, and
// reading them into memory to regex-scan as text is wasteful.
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // 2 MiB

// Extensionless credential filenames (e.g. SSH keys) are scanned even
// though they have no extension; the `ext === ""` branch below covers
// these along with other extensionless text files (Dockerfile, LICENSE).
function isTextFile(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === "") return true; // extensionless (id_rsa, Dockerfile, LICENSE, ...)
  return !SKIP_EXTENSIONS.has(ext);
}

// Routed through the same `globToRegExp` used for `secretAllowlist` entries
// so a `*` can appear anywhere in the pattern (e.g. `.env.*.example`), not
// just as a leading wildcard.
function isIgnored(name: string): boolean {
  return IGNORE_FILES.some((p) => (p.includes("*") ? globToRegExp(p).test(name) : name === p));
}
