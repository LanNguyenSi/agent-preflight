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
  // Quoted-key support: an optional `["']?` sits
  // directly after the identifier, on all three of these, so a
  // quoted-key serialization — `"api_key": "<value>"` in JSON, or
  // `'token': '<value>'` in quoted YAML/Python — is detected too.
  // Without it, the identifier had to be followed immediately by
  // `\s*[:=]` with nothing in between, which a quoted key never
  // satisfies (its own closing quote sits in that gap). Unquoted forms
  // without an adjacent quote character are unaffected: the `["']?` is
  // optional and matches zero characters there.
  //
  // Known false-positive class: the same quoted-key shape is extremely common in non-secret
  // JSON — OpenAPI/Swagger specs (`"api_key": {"type": "apiKey", ...}`-
  // adjacent example values), Postman collections, and recorded HTTP
  // fixture files that happen to name a header/field `api_key`/`token`/
  // `secret` and give it a realistic-looking >=20-char placeholder or a
  // recorded (non-secret) value such as a UUID or a commit SHA. This
  // pattern deliberately does NOT special-case that shape — see the
  // per-decision test fixtures in tests/secrets.test.ts pinning both a
  // blocked `"token": "<40-hex>"` outside tests/ and the tests/-directory
  // fixture downgrade for a `test-`-prefixed quoted-key value. An operator
  // who hits this on a genuine fixture file has two escape hatches: the
  // `secretAllowlist` config entry (path or path:line, supports globs) or
  // an inline `// pragma: allowlist secret` / `# pragma: allowlist secret`
  // comment on the offending line.
  /(?:api[_-]?key|apikey)["']?\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}["']?/i,
  /(?:password|passwd|pwd)["']?\s*[:=]\s*["'][^"']{8,}["']/i,
  /(?:secret|token)["']?\s*[:=]\s*["'][a-zA-Z0-9_-]{20,}["']/i,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  // AWS access key ID: a fixed, unambiguous shape (`AKIA` + 16 uppercase
  // alphanumeric chars) — no surrounding keyword needed, same rationale
  // as the bare `ghp_...` entry above. Also listed in
  // HIGH_CONFIDENCE_PATTERNS below: the AWS docs'
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
  // Boundary-anchored: a bare `(?<![A-Z0-9])`/`(?![A-Z0-9])` lookbehind/lookahead
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
  // Prefix coverage: AKIA alone excludes AWS's other 20-char
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
  //     uppercase-alphanumeric characters. Residual note: `ACCA` itself
  //     is all-hex (A/C/C/A are all valid hex digits), so a 20-char
  //     uppercase-hex identifier that happens to start with the 4
  //     characters `ACCA` would also match and block — roughly 1 in
  //     65536 of such identifiers (4 fixed hex-digit-shaped characters
  //     out of 16 possible each). Accepted: this matches gitleaks and
  //     detect-secrets, which use the identical prefix set and carry the
  //     identical residual risk.
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
  // so a
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
  // End-anchored, like the sibling identifier-variant pattern below:
  // without the trailing `(?![A-Za-z0-9/+=])`, `{40}`
  // finds any 40-char run as a PREFIX of a longer base64-ish value too -- a
  // 200-char JWT or session token beginning with 40 charset-compatible
  // characters would false-positive as a 40-char AWS secret key under this
  // literal `aws_secret_access_key` identifier exactly as it would under
  // the identifier-variant pattern below; AWS secret access keys are
  // always exactly 40 characters, so a longer value is never one. The
  // lookahead requires the value to actually END at 40 characters; see
  // tests/secrets.test.ts for the 41+-char pass and the 40-char control.
  //
  // Despite
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
  /aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])["']?/i,
  // AWS secret access key identifier variants: the pattern above requires the word
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
  // AWS-specific). NOT being in HIGH_CONFIDENCE_PATTERNS is NOT a
  // safety mitigation: every SECRET_PATTERNS match on a changed
  // committable file still hard-blocks regardless (see scanDir). The
  // only effect of the omission is that a match under tests/ stays
  // eligible for the TEST_FIXTURE_VALUE_PATTERN downgrade to `warn`
  // (HIGH_CONFIDENCE_PATTERNS forces `testFixture: false`, which would
  // remove that eligibility) — see the block comment above
  // HIGH_CONFIDENCE_PATTERNS below.
  //
  // Requires `(?![A-Za-z0-9/+=])` right after the 40-char
  // value: without it, `{40}` finds
  // any 40-char run as a PREFIX of a longer base64-ish value too — a
  // 200-char JWT or session token beginning with 40 charset-compatible
  // characters would false-positive as a 40-char AWS secret key. The
  // lookahead requires the value to actually END at 40 characters.
  /(?:aws[_-]?)?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])["']?/i,
  // AWS secret key, "no access" identifier variants: `aws_secret_key` (Ansible's `aws_secret_key` module
  // parameter) and bare `secret_key` (Terraform's conventional variable
  // name for this same credential) both drop the word "access" from the
  // identifier entirely. `secret[_-]?key` alone (no "access", no "aws")
  // is a BROAD identifier — Django's `SECRET_KEY`, a Stripe
  // `secret_key`/API key, a generic app signing key, etc. all use it —
  // so this is deliberately gated on the
  // exact same 40-char-base64-ish, exactly-bounded value shape as the
  // two patterns above (not added as a bare keyword match, and not
  // added to HIGH_CONFIDENCE_PATTERNS). As with the pattern above, NOT
  // being in HIGH_CONFIDENCE_PATTERNS is NOT a safety mitigation — a
  // match on a changed committable file still hard-blocks; the only
  // effect is keeping the tests/-fixture downgrade reachable. Residual
  // false-positive reasoning for why this is still an acceptable risk at
  // that value shape: Django's default `SECRET_KEY` generator draws from
  // a ~70-char alphabet that includes `!@#$%^&*(-_=+)` — most of which
  // (`!@#$%^&*(` plus the frequently-used `-`/`_`) fall OUTSIDE this
  // pattern's `[A-Za-z0-9/+=]` charset, so a real Django-generated value
  // breaks the match within the first few characters far more often than
  // not; Stripe secret keys are `sk_live_`/`sk_test_`-prefixed and the
  // underscores after `sk` break the charset-run immediately too. The
  // residual case — an app's custom "secret key" happens to be exactly
  // 40 chars of `[A-Za-z0-9/+=]` with no separator — is accepted as the
  // same class of risk the pattern above already carries for
  // `secret_access_key`, not a new one; see
  // tests/secrets.test.ts for the Django-shaped negative control.
  //
  // Leading identifier boundary: `secret[_-]?key` alone, with no boundary in front of it, also
  // matched as a SUFFIX of a longer identifier — `MY_SECRET_KEY`,
  // `jwt_secret_key`, `app_secret_key`, etc. That is a much broader,
  // much less AWS-specific identifier family than this pattern is meant
  // to cover; those belong (if anywhere) to a generic app-secret pattern,
  // not this AWS-named one. `(?<![A-Za-z0-9_])` in front of the optional
  // `aws[_-]?` requires the match to start at an actual identifier
  // boundary — treating `_` as an identifier-continuation character to
  // block env-var-suffix cases like `MY_SECRET_KEY`, while permitting a
  // leading hyphen (CLI flag / YAML dash forms `--secret-key=`, `-secret_key:`)
  // to match, the same way a real variable-name boundary works — so only a
  // standalone `secret_key`/`secretkey`/`secret-key` identifier (or one
  // explicitly `aws_`/`aws-`-prefixed) matches; `MY_SECRET_KEY` and
  // `jwt_secret_key` are deliberately NOT this pattern's job now (see
  // tests/secrets.test.ts). This narrows the pattern; it does not widen
  // it — every case that matched via a genuine standalone `secret_key`
  // still matches, since a standalone identifier always sits at such a
  // boundary already (start of line, whitespace, quote, `{`, etc.).
  //
  // 40-hex collision (documented, not fixed): a standalone `secret_key`
  // identifier assigned a 40-character hex string — `openssl rand -hex
  // 20`, Python's `secrets.token_hex(20)`, or a raw git SHA-1 — sits
  // entirely inside this pattern's `[A-Za-z0-9/+=]` value charset (hex
  // digits are a subset of it) and WILL block. This is accepted, not
  // fixed: a 40-char hex value assigned to a variable literally named
  // `secret_key` is a plausible real secret (hex is a completely
  // ordinary secret-value encoding), so declining to flag it would trade
  // a real detection for a narrower false-positive surface. See
  // tests/secrets.test.ts for the pinned `secret_key = "<40-hex>"` fail.
  /(?<![A-Za-z0-9_])(?:aws[_-]?)?secret[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])["']?/i,
];

// High-confidence secret shapes: a match against either of these anywhere on the line means the
// line unambiguously carries a real credential format, not just a
// name-looks-like-a-secret heuristic. SECRET_PATTERNS above is checked in
// order and scanDir stops at the FIRST pattern that matches a given line
// (see the `break` there), so a line such as
// `TOKEN = "test-ghp_<36 chars>"` trips the earlier, weaker
// `(?:secret|token)\s*[:=]...` pattern first; without the full-line re-check, the genuinely
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
  // AWS access key ID: see the SECRET_PATTERNS
  // entry above for the full rationale, including the deliberate
  // no-exemption decision for AWS's canonical example access-key-id and
  // the boundary-anchoring rationale.
  // Prefix alternation (AKIA/ASIA/ABIA/ACCA/A3T) widened in lockstep
  // with the SECRET_PATTERNS entry — see
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

// Test-fixture value heuristic: a secret-shaped
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
// Anchored to the FIRST `:`/`=` on the matched text: `^[^:=]*[:=]` consumes everything up
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

// Only DIRECTORY segments count: `.slice(0, -1)` drops the last segment, which is always the
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
 * Secret detection with git-aware, diff-scoped severity. A finding is a hard blocker (`fail`) only when
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
 *     This tier is reachable only on the filesystem-walk fallback: inside
 *     a git work tree the scanned set comes from `git ls-files`, which
 *     never lists such files, so they are not read at all.
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

  // Inside a git work tree, scan exactly the committable set that git
  // reports (tracked plus untracked-not-ignored). That keeps gitignored
  // dependency trees (CMS webroots, vendored cores, ...) from being read
  // at all. Outside git, or when git fails, fall back to the filesystem
  // walk so a git problem never means "scanned nothing".
  // One environment for every git call below (listing, ignore
  // classification, diff scope), so they all describe the same repository.
  const git: GitContext = { repoPath, env: await resolveGitEnv(repoPath) };
  const gitFiles = await listCommittableFiles(git);
  if (gitFiles !== null) {
    scanFileList(gitFiles, repoPath, rawFindings);
  } else {
    scanDir(repoPath, repoPath, rawFindings);
  }

  const allowlist = config.secretAllowlist ?? [];
  const findings = rawFindings.filter((f) => !matchesAllowlist(f, allowlist));

  // `git check-ignore` over just the finding files (not the whole tree).
  const uniqueFiles = [...new Set(findings.map((f) => f.file))];
  const { gitAvailable, ignoredUntracked, unclassified } = await classifyIgnored(git, uniqueFiles);
  if (findings.length > 0 && !gitAvailable) {
    limitations.push(
      "secret-detection: not a git repository (or git unavailable); findings reported as non-blocking warnings",
    );
  }
  if (unclassified > 0) {
    limitations.push(
      `secret-detection: git could not classify ${unclassified} path(s); they are treated as committable (eligible to block)`,
    );
  }

  // Diff scope: the set of files the current branch changed (vs. its
  // merge-base with the default/upstream branch) plus new untracked
  // files. `null` means the base could not be resolved — the caller
  // then fails safe by treating every committable finding as blocking.
  const strict = config.secretDetectionStrict === true;
  let changedFiles: Set<string> | null = null;
  if (gitAvailable && !strict && findings.length > 0) {
    changedFiles = await resolveChangedFiles(git);
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
    message = `${warning.length} potential secret(s) in non-blocking location(s) (pre-existing, docs, test-fixture, non-git, or gitignored on the walk fallback)`;
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
 * the "cannot leak via git" set. Paths travel NUL-separated (newlines and
 * non-ASCII names survive verbatim) and each is prefixed with `./`, which
 * `check-ignore` echoes back unchanged: a file name that starts with `:`
 * (`:(exclude)x.js`) would otherwise be parsed as pathspec magic, which
 * `check-ignore` rejects with a fatal error. `--literal-pathspecs` is not
 * an option here, `check-ignore` refuses that magic too.
 *
 * `gitAvailable: false` is reserved for "this is not a git work tree" (or
 * git cannot run): the caller then reports every finding as non-blocking.
 * Inside a confirmed work tree a path git cannot classify (the whole batch
 * fails because of it, for example with a corrupt index) is never
 * allowed to downgrade other findings: the batch is retried path by path
 * and each path that still fails is simply not in the ignored set, so it
 * stays eligible to block.
 */
async function classifyIgnored(
  git: GitContext,
  relFiles: string[],
): Promise<{ gitAvailable: boolean; ignoredUntracked: Set<string>; unclassified: number }> {
  const none = (gitAvailable: boolean, unclassified = 0) => ({
    gitAvailable,
    ignoredUntracked: new Set<string>(),
    unclassified,
  });
  if (relFiles.length === 0) return { ...none(true) };
  const checkIgnore = (paths: string[]) =>
    gitExec(git, ["check-ignore", "--stdin", "-z"], {
      input: paths.map((p) => `./${p}\0`).join(""),
      raw: true,
    });
  const parse = (stdout: string) =>
    stdout.split("\0").filter((p) => p.length > 0).map((p) => (p.startsWith("./") ? p.slice(2) : p));
  try {
    const res = await checkIgnore(relFiles);
    // 0 = at least one path ignored, 1 = none ignored: a healthy repo.
    if (res.exitCode === 0 || res.exitCode === 1) {
      return { gitAvailable: true, ignoredUntracked: new Set(parse(res.stdout)), unclassified: 0 };
    }
    // Anything else (128 = fatal): not a work tree, or one path poisons the batch.
    const inside = await gitExec(git, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return none(false);
    const ignored = new Set<string>();
    let unclassified = 0;
    for (const rel of relFiles) {
      const one = await checkIgnore([rel]);
      if (one.exitCode === 0) for (const p of parse(one.stdout)) ignored.add(p);
      else if (one.exitCode !== 1) unclassified++;
    }
    return { gitAvailable: true, ignoredUntracked: ignored, unclassified };
  } catch {
    // git binary missing (ENOENT) or spawn failure.
    return none(false);
  }
}

/** Where and with which environment every git call of one secret-detection run executes. */
export interface GitContext {
  repoPath: string;
  env: NodeJS.ProcessEnv;
}

const GIT_REDIRECT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_PREFIX"];

/**
 * Pathspec mode switches. They select no repository, but `check-ignore`
 * rejects every call while one is set, so they are never inherited.
 */
const GIT_PATHSPEC_VARS = [
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
];

/**
 * Choose the environment for every git call of this run, once.
 *
 * Variables such as `GIT_DIR` and `GIT_WORK_TREE` are not always noise.
 * Hooks of a repository whose git directory is chosen explicitly (a bare
 * repository with `--work-tree`, as dotfile managers use) export them, and
 * discovery from the scanned directory would find no repository at all.
 * But when they point at some other repository they make `git ls-files`
 * list that repository's paths (scanning nothing) and make the ignore and
 * diff-scope classification describe the wrong repository, which can
 * downgrade a real blocker to a warning. So:
 *
 *   - The inherited environment is used when the repository it selects has
 *     a work tree containing the scanned directory AND is the same
 *     repository (same common git dir) that plain discovery from the
 *     scanned directory finds, or discovery finds none (an env-only
 *     repository). This keeps hook environments, linked worktrees and
 *     bare-plus-work-tree setups intact.
 *   - Otherwise the variables are considered to point elsewhere and are
 *     removed (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
 *     `GIT_PREFIX`), and so is `GIT_INDEX_FILE`: it was exported for the
 *     other repository, so its index says nothing about this one.
 *
 * In the inherited choice `GIT_INDEX_FILE` is kept: a hook running
 * `git commit` points it at the index being committed, and the listing
 * should agree with it. A file that is tracked only in the real index and
 * matches an ignore rule is then not listed, which is acceptable because it
 * is not part of the commit being made. Untracked files are unaffected:
 * `--others` lists everything in the work tree that the chosen index does
 * not track.
 */
async function resolveGitEnv(repoPath: string): Promise<NodeJS.ProcessEnv> {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_PATHSPEC_VARS) delete inherited[key];
  if (!GIT_REDIRECT_VARS.some((k) => inherited[k] !== undefined)) return inherited;

  const scrubbed: NodeJS.ProcessEnv = { ...inherited };
  for (const key of [...GIT_REDIRECT_VARS, "GIT_INDEX_FILE"]) delete scrubbed[key];

  const inheritedCtx: GitContext = { repoPath, env: inherited };
  if ((await worktreeRelativePath(inheritedCtx)) === null) return scrubbed;
  const discovered = await gitCommonDir({ repoPath, env: scrubbed });
  if (discovered === null) return inherited; // env-only repository
  const selected = await gitCommonDir(inheritedCtx);
  return selected !== null && selected === discovered ? inherited : scrubbed;
}

/** Real path of the common git directory selected by `git.env` from `git.repoPath`, or null. */
async function gitCommonDir(git: GitContext): Promise<string | null> {
  try {
    const res = await gitExec(git, ["rev-parse", "--git-common-dir"], { raw: true });
    if (res.exitCode !== 0 || res.failed) return null;
    return fs.realpathSync(path.resolve(git.repoPath, res.stdout.replace(/\r?\n$/, "")));
  } catch {
    return null;
  }
}

/**
 * Path of `git.repoPath` relative to the top level of its work tree
 * (`""` when it is the top level), or null when there is no work tree or
 * it does not contain `git.repoPath`.
 */
async function worktreeRelativePath(git: GitContext): Promise<string | null> {
  try {
    const top = await gitExec(git, ["rev-parse", "--show-toplevel"], { raw: true });
    if (top.exitCode !== 0 || top.failed) return null;
    const realTop = fs.realpathSync(top.stdout.replace(/\r?\n$/, ""));
    const realRepo = fs.realpathSync(git.repoPath);
    const rel = path.relative(realTop, realRepo);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return rel;
  } catch {
    return null;
  }
}

/** Run git in `git.repoPath` with the chosen environment; never rejects on a non-zero exit. */
function gitExec(
  git: GitContext,
  args: string[],
  options: { input?: string; raw?: boolean } = {},
) {
  return execa("git", args, {
    cwd: git.repoPath,
    env: git.env,
    extendEnv: false,
    reject: false,
    input: options.input,
    ...(options.raw ? { stripFinalNewline: false, maxBuffer: 512 * 1024 * 1024 } : {}),
  });
}

/**
 * The committable files below `repoPath`: tracked files plus untracked
 * files that no ignore rule excludes, as `repoPath`-relative,
 * forward-slash paths (NUL-separated on the wire, so spaces, newlines and
 * non-ASCII names survive verbatim). Gitignored untracked files are
 * deliberately absent: they cannot reach the remote, and enumerating
 * them is what made the filesystem walk read whole dependency trees.
 *
 * When `repoPath` is a subdirectory of the git root, git lists only that
 * subtree, relative to it, which matches `Finding.file` of the walk.
 * Returns `null` (caller falls back to the walk) whenever the listing
 * cannot be trusted to cover `repoPath`:
 *
 *   - `repoPath` is not in a git work tree, git is missing, or any git
 *     command fails (including output beyond the buffer limit);
 *   - the work tree's top level does not contain `repoPath`;
 *   - `repoPath` is itself inside a parent repository and is ignored by
 *     it (an ignored build directory, a project under an
 *     ignore-everything dotfiles repository): git would list nothing;
 *   - git lists entries but none of them exists on disk, which means the
 *     listing describes some other tree.
 */
async function listCommittableFiles(ctx: GitContext): Promise<string[] | null> {
  const { repoPath } = ctx;
  const git = (args: string[]) => gitExec(ctx, args, { raw: true });
  try {
    const rel = await worktreeRelativePath(ctx);
    if (rel === null) return null;
    if (rel !== "") {
      // repoPath is a subdirectory of the work tree; if the parent
      // repository ignores it, ls-files would silently list nothing.
      const ignored = await git(["check-ignore", "-q", "--", "."]);
      // Exit 1 = not ignored. Exit 0 = ignored; anything else = git error.
      if (ignored.exitCode !== 1) return null;
    }
    const res = await git([
      "-c", "core.quotePath=false",
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ]);
    if (res.exitCode !== 0 || res.failed) return null;
    // A merge conflict lists a path once per index stage; dedupe.
    const files = [...new Set(res.stdout.split("\0").filter((p) => p.length > 0))];
    if (files.length > 0 && !files.some((f) => existsOnDisk(path.join(repoPath, ...f.split("/"))))) {
      return null;
    }
    return files;
  } catch {
    return null;
  }
}

function existsOnDisk(fullPath: string): boolean {
  try {
    fs.lstatSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan a git-listed file set with the same filters the walk applies: a
 * path is skipped when any segment (directory or file name) is in
 * SKIP_DIRS, and file-level filters (`isTextFile`, `IGNORE_FILES`, size
 * cap) are shared via `scanFile`. Only regular files are read, and only
 * when every directory between `root` and the file is a real directory:
 * a symlink is never followed, neither as the file itself nor as any
 * parent directory (git lists a tracked path even when its directory was
 * replaced on disk by a symlink, possibly to a tree outside the
 * repository), exactly like the walk, which never descends a symlinked
 * directory. Gitlink/submodule entries and nested repositories (a
 * directory, not a file) are skipped, since their contents are not
 * committable into this repository. A path git lists but that no longer
 * exists in the work tree (deleted, not yet staged) is skipped.
 */
function scanFileList(relPaths: string[], root: string, findings: Finding[]): void {
  // Verdict per directory prefix ("a", "a/b"): is it a real directory
  // (not a symlink) whose own parents all are? Shared across the run.
  const realDirs = new Map<string, boolean>();
  const isRealDir = (segments: string[]): boolean => {
    if (segments.length === 0) return true;
    const key = segments.join("/");
    const cached = realDirs.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    if (isRealDir(segments.slice(0, -1))) {
      try {
        ok = fs.lstatSync(path.join(root, ...segments)).isDirectory();
      } catch {
        ok = false;
      }
    }
    realDirs.set(key, ok);
    return ok;
  };
  for (const rel of relPaths) {
    const segments = rel.split("/");
    if (segments.some((seg) => SKIP_DIRS.has(seg))) continue;
    if (!isRealDir(segments.slice(0, -1))) continue;
    const fullPath = path.join(root, ...segments);
    try {
      if (!fs.lstatSync(fullPath).isFile()) continue;
    } catch {
      continue; // listed by git but missing from the work tree
    }
    scanFile(fullPath, segments[segments.length - 1] ?? rel, root, findings);
  }
}

/** Run a git command; return stdout on a clean exit, `null` on any failure. */
async function runGit(git: GitContext, args: string[]): Promise<string | null> {
  try {
    const res = await gitExec(git, args);
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
 *     are uncommitted edits (a freshly cloned repo
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
export async function resolveDiffBase(git: GitContext): Promise<string | null> {
  const headSha = (await runGit(git, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const candidates: DiffBaseCandidate[] = [];
  const upstream = await runGit(git, [
    "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
  ]);
  if (upstream) candidates.push({ ref: upstream.trim(), trusted: true });
  const originHead = await runGit(git, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead) candidates.push({ ref: originHead.trim(), trusted: true });
  candidates.push(
    { ref: "origin/main", trusted: true },
    { ref: "origin/master", trusted: true },
    { ref: "main", trusted: false },
    { ref: "master", trusted: false },
  );

  for (const { ref, trusted } of candidates) {
    if (!ref) continue;
    const mb = (await runGit(git, ["merge-base", "HEAD", ref]))?.trim();
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
async function resolveChangedFiles(git: GitContext): Promise<Set<string> | null> {
  const base = await resolveDiffBase(git);
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
  const diff = await runGit(git, [
    "-c", "core.quotePath=false", "diff", "--name-only", "--relative", base,
  ]);
  if (diff === null) return null;
  for (const line of diff.split("\n")) {
    const p = line.trim();
    if (p) changed.add(p);
  }
  // New files not yet tracked (and not gitignored) are part of this change.
  const others = await runGit(git, [
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
    } else if (entry.isFile()) {
      scanFile(fullPath, entry.name, root, findings);
    }
  }
}

/** Scan one file's lines for secret patterns, applying the file-level filters. */
function scanFile(fullPath: string, name: string, root: string, findings: Finding[]): void {
  if (!isTextFile(name) || isIgnored(name)) return;
  let content: string;
  try {
    if (fs.statSync(fullPath).size > MAX_SCAN_BYTES) return; // skip large blobs
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return; // ignore read errors
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
