# Secret scanner investigation

Investigation task, not a guaranteed PR: this document is the deliverable. It
decides between three paths for the `secret-detection` check's detection
engine and records the measurements the decision rests on. No scanner
integration is implemented here; see [Follow-up scope](#follow-up-scope) for
what a follow-up task would build.

## Current state

`src/checks/secrets.ts` scans every non-binary, non-skipped file under the
repo root with five hand-rolled regexes (`SECRET_PATTERNS`):

- `(?:api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}["']?`
- `(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']`
- `(?:secret|token)\s*[:=]\s*["'][a-zA-Z0-9_-]{20,}["']`
- `ghp_[a-zA-Z0-9]{36}` (GitHub classic PAT)
- `-----BEGIN (?:RSA |EC )?PRIVATE KEY-----`

A match is suppressed if the matched text hits one of five placeholder
patterns (`PLACEHOLDER_PATTERNS`: `your_..._here`, `your_..._key`,
`example[_-]?key`, `placeholder`, `<your_`), or if the line carries a
`pragma: allowlist secret` comment. Findings then go through git-aware,
diff-scoped severity (not part of this investigation): a `.md` file, a
gitignored-and-untracked file, a non-git directory, or a file the current
branch never touched all downgrade to `warn`; everything else is a `fail`.
The check never shells out and has no external dependency - it fails closed
by construction, never fails open.

Known gaps going in (from the task brief, 2026-05-18 project-forge run): 3
false positives, two from `.next/` build output (mitigated since by adding
`.next` etc. to `SKIP_DIRS`); no coverage for AWS keys, GCP service-account
JSON, Stripe keys, Slack tokens, or JWTs.

## Methodology

Two synthetic corpora were built in a scratchpad directory (not committed;
summarized in the [Appendix](#appendix-corpus-and-raw-output-summary)):

- **TP corpus** (`corpus/tp/`, 10 files): one example per credential class -
  AWS access key, GitHub classic PAT (`ghp_`), GitHub fine-grained PAT
  (`github_pat_`), Stripe secret key, Slack bot token, JWT, a GCP
  service-account JSON blob, an RSA private key (real key material generated
  locally with `openssl genrsa`, not a leaked credential), a generic
  `password=` assignment, and a generic `api_key=` assignment. All values are
  synthetic/randomly generated, not real credentials.
- **FP corpus** (`corpus/fp/`, 4 files): `.env.example`-style placeholders
  (`YOUR_API_KEY_HERE`, `<your_slack_bot_token>`, ...), a synthetic
  `.next`-style minified build chunk with long hash-like strings assigned to
  `token`/`secret`/`apiKey`-named variables, an npm-lockfile-style block with
  `integrity: "sha512-..."` hashes, and a `*.test.ts` fixture file with fake
  credentials.

Three candidates were run over both corpora:

1. **In-tree regexes**: a standalone Node script
   (`run-intree.mjs`) that replicates `SECRET_PATTERNS`,
   `PLACEHOLDER_PATTERNS`, `ALLOWLIST_PRAGMA`, `IGNORE_FILES`, and
   `isTextFile` verbatim from `src/checks/secrets.ts` (a live import wasn't
   practical - the module also pulls in `fs`/`execa`/`PreflightConfig` - so
   this is the "repliziert" option the task brief allows for).
2. **gitleaks v8.30.1** (darwin-arm64), downloaded from the GitHub release,
   checksum-verified against the published `gitleaks_8.30.1_checksums.txt`,
   run as `gitleaks detect --no-git --no-banner -s <corpus> -f json -r
   <out> --exit-code 0` with its default ruleset (no custom config).
3. **trufflehog v3.97.0** (darwin-arm64), downloaded from the GitHub
   release, checksum-verified against the published
   `trufflehog_3.97.0_checksums.txt`, run as `trufflehog filesystem
   <corpus> --no-verification --json`. `--no-verification` skips live API
   calls against the (fake) credentials, which matters for both realism -
   the synthetic values are not live secrets and would only fail
   verification anyway - and to avoid making outbound calls to third-party
   APIs from a scratchpad experiment.

Both binaries were downloaded to and run from the scratchpad's
`scanners/` directory, never installed system-wide.

### Limitations

This is a synthetic, small-n investigation, not a benchmark: n=1-2 samples
per credential class (10 TP files, 4 FP files total). Every hit/miss result
below is a per-sample outcome, not a measured rate - as the gitleaks
generic-password result shows, a single class's result can be
value-dependent (which specific characters the synthetic secret happens to
contain), so a "HIT" or "MISS" for a class should not be read as an implied
precision or recall percentage. No real-world corpus (an actual git
history, a real CI build tree) was scanned; all findings are against the
two purpose-built synthetic corpora described above. trufflehog's live
credential-verification path (calling out to the provider API to confirm a
found credential is still active) was not exercised - `--no-verification`
was used throughout, so this investigation says nothing about that mode's
behavior, false-positive rate, or latency.

## Results

### True-positive coverage by class

| Class | In-tree regex | gitleaks | trufflehog |
|---|:---:|:---:|:---:|
| AWS access key (`AKIA`/`ASIA`/`ABIA`/`ACCA`/`A3T...`) | HIT (added agent-tasks 211f559c, widened 9ef05069 - out of date with the rest of this snapshot, see CHANGELOG) | HIT | HIT |
| GitHub classic PAT (`ghp_`) | HIT | HIT | HIT |
| GitHub fine-grained PAT (`github_pat_`) | MISS | HIT | HIT |
| Stripe secret key (`sk_live_`/`sk_test_`) | MISS | HIT | HIT |
| Slack bot token (`xoxb-`) | MISS | HIT | MISS |
| JWT | MISS | HIT | MISS |
| GCP service-account JSON | HIT (incidental - matches the PEM header embedded in `private_key`) | HIT (incidental - same PEM-header match via the `private-key` rule, not a dedicated GCP detector) | HIT (dedicated `GCP` detector, structural - not PEM-dependent) |
| RSA private key (PEM) | HIT | HIT | HIT |
| Generic `password = "..."` | HIT | MISS (value-dependent - see below) | MISS |
| Generic `api_key = "..."` | HIT | HIT | MISS |
| **Classes hit / 10** | **6** (was 5 at the time of this investigation; AWS moved to HIT after this doc was written) | **9** | **6** |

> **Note (2026-08-18, superseding):** the AWS access-key row above
> predates agent-tasks 211f559c; the in-tree regexes now HIT this class —
> re-measured 2026-08-18. This note supersedes only that one row; the
> table itself is left as originally measured, and a full corpus refresh
> (re-running every row above against the current in-tree regexes) is a
> filed follow-up, not done here.

Two results are worth calling out because they cut against the intuitive
"specialized tool wins everywhere" story:

- gitleaks has no dedicated password rule, but its `generic-api-key` rule is
  charset-based, not keyword-scoped, so it does catch some
  `password = "..."` assignments incidentally, whenever the value happens to
  fall inside that rule's character class. Both TP-corpus password values
  (`tr0ub4dor&3xyz`, `S0m3R3allyG00dPassw0rd!`) contain `&` or `!`, outside
  that charset, so both MISS here; a follow-up probe over five
  password-shaped variants found 3 of 5 HIT once the value was
  charset-conformant (alnum/`-`/`_` only). This is value-dependent, not the
  clean "no rule for this class" gap the in-tree regex avoids by design.
- trufflehog's detector-based (not entropy-based) design means it has **no
  generic `password=`/`api_key=` catch-all** - a Slack `xoxb-` token went
  undetected with the default detector set, and trufflehog's JWT detector
  did not fire on a plain HS256 token with no service-specific structure.
  (Trufflehog ships ~800 service-specific detectors; a credential that
  doesn't match one of them structurally is invisible to it by design,
  which is also why its false-positive rate is so low - see below.)

### False positives

| Corpus file | In-tree regex | gitleaks | trufflehog |
|---|:---:|:---:|:---:|
| `01-placeholders.txt` (5 lines) <!-- pragma: allowlist secret --> | 1 FP (`password = "example-password-please-change"` slips past `PLACEHOLDER_PATTERNS` - "example" isn't immediately followed by "key") | 0 FP | 0 FP |
| `02-next-build-output.js` (hashed build vars) | 3 FP (`token=`, `secret=`, `apiKey=` assigned to long hash-like strings) | 3 FP (all via the `generic-api-key` rule) | 0 FP |
| `03-lockfile-integrity.txt` (`integrity: sha512-...`) | 0 FP | 0 FP | 0 FP |
| `04-test-fixture.test.ts` | 0 FP (skipped via `IGNORE_FILES`'s `*.test.ts` pattern) | 0 FP | 0 FP |
| **Total FP count** | **4** | **3** | **0** |

The `.next`-style build-output false positive the task brief calls out is
reproduced here for the in-tree regex, and **gitleaks reproduces it too**
(same 3 lines, via its own generic high-entropy rule) - gitleaks is not
immune to this FP class, it just has no rule for the other FP class
(placeholder passwords) the in-tree tool half-misses. trufflehog's
structural-detector design means it never fires on any of the four FP
files. Note that in production the `.next`/`.cache`/etc. `SKIP_DIRS`
entries (added 2026-05-18, after the original FP incident) would already
keep the in-tree tool from ever seeing a real `.next/` file; a gitleaks
wrapper would need equivalent exclude configuration to match that existing
mitigation, since it currently only lives in the in-tree scanner's `scanDir`
walk, not in an external tool's config. Two candidate exclude mechanisms
were probed here and only one works. `--gitleaks-ignore-path` points
gitleaks at a `.gitleaksignore` file, but that file's entries are match
*fingerprints* (the hash gitleaks prints per finding), not paths - pointing
it at path-like entries (`.next/`, `.next/*`) does not suppress the FPs:
the same 3 `.next/chunk.js` findings still fire with the ignore file in
place. `--exclude-paths` is not a gitleaks flag at all - it belongs to
trufflehog. What actually works, confirmed here: a `.gitleaks.toml` config
passed via `--config` that sets `[extend] useDefault = true` (keep the
built-in rules) and adds an `[allowlist] paths = ['(^|/)\.next/',
'(^|/)\.cache/']` regex exclude - verified 3 findings -> 0 on the same
`.next`-build-output fixture.

### Runtime, size, license

| | In-tree regex | gitleaks v8.30.1 | trufflehog v3.97.0 |
|---|---|---|---|
| Runtime over the ~4 KB TP corpus | ~2 ms (in-process, no spawn) | ~210 ms wall (scan itself: 81 ms; rest is process startup) | ~2.0 s wall (scan itself: 9.8 ms; rest is process startup / detector-registry init) |
| Runtime over this repo's tracked source (~1.4 MB) | not measured (script doesn't replicate `SKIP_DIRS`; would need to walk `node_modules`) | ~280 ms wall (scan itself: 97 ms), 0 leaks found | ~2.3 s wall (scan itself: 87 ms), 0 leaks found |
| Binary size (darwin-arm64) | n/a (ships as part of the Node package) | 7.9 MB archive / 21.3 MB extracted (`gitleaks_8.30.1_darwin_arm64.tar.gz`, sha256 `b40ab0ae...b6a5`) | 70.2 MB archive / 169.7 MB extracted (`trufflehog_3.97.0_darwin_arm64.tar.gz`, sha256 `ad0a99bd...c5c`) - roughly 8x (extracted) to 9x (archive) gitleaks |
| License | project's own (MIT, `agent-preflight`) | MIT | **AGPL-3.0** (confirmed from the extracted `LICENSE` file: "GNU AFFERO GENERAL PUBLIC LICENSE Version 3") |

On the license: AGPL is a copyleft license that attaches to *modifying and
distributing the AGPL program itself* (or running a modified version as a
network service). Shelling out to an unmodified `trufflehog` binary as a
separate process does not put `agent-preflight`'s own MIT-licensed source
under AGPL obligations - this is the same relationship most CI tools have
with `git` (GPL) or other GPL/AGPL CLI dependencies invoked as a subprocess.
It is worth flagging for a follow-up regardless: if a future implementation
considered *vendoring/redistributing* the trufflehog binary inside the
`agent-preflight` npm package (as opposed to fetching it on demand at
install/run time), that would raise a real packaging question that gitleaks'
MIT license does not.

Both processes' wall time is dominated by fixed per-invocation startup, not
by corpus size at this scale - trufflehog's is roughly 10x gitleaks' and
would show up as measurable overhead on every `preflight` run if it ran
unconditionally.

## The three paths, measured

**1. Replace** - swap `SECRET_PATTERNS` for a gitleaks or trufflehog
subprocess wrapper, external dependency, fail-open if the binary is missing.

- Pro: gitleaks materially increases class coverage measured here (9/10 vs.
  5/10, ~1.8x) and has a lower raw FP count than the in-tree regexes (3 vs.
  4 in this corpus - see the Recommendation below for why that raw
  comparison isn't the full precision picture). trufflehog has the cleanest
  FP rate of the three (0) but
  the weakest generic-pattern coverage (6/10, worse than gitleaks on JWT,
  Slack, and both generic-assignment classes).
- Con: this is the one path the task brief already flags as fail-open by
  necessity - a missing binary can't be a hard `fail` without breaking every
  environment that hasn't installed the tool, which silently weakens the
  check's git-aware `fail`-blocking guarantee exactly when the operator
  least expects it (a fresh CI image, a contributor's laptop without
  gitleaks on `PATH`). It also adds an external dependency to a tool whose
  current pitch is "no external dependency, never fails open." Reproducing
  the existing `SKIP_DIRS` false-positive mitigation requires new
  exclude-path plumbing either way.

**2. Augment** - keep the regexes as the always-on default; add an opt-in
`.preflight.json` `secretDetection.scanner: "gitleaks"` (or `"trufflehog"`)
that layers the external tool's findings on top when configured and
installed.

- Pro: zero change to the default, dependency-free, fail-closed behavior -
  every existing installation keeps exactly what it has today. An operator
  who wants gitleaks' 9/10 class coverage and lower FP rate opts in
  explicitly and accepts the external-dependency tradeoff knowingly. A
  missing binary in opt-in mode is an honest configuration error, not a
  silent capability regression, because the operator asked for it.
- Con: two detection engines to document and reason about; findings from the
  regex and the external scanner need a shared `Finding` shape and combined
  severity handling (the diff-scoping / `.md` / gitignored logic already in
  `runSecretDetection` would need to apply uniformly to both sources). The
  regex baseline's real gaps (no AWS, no GCP, no Stripe, no Slack, no JWT)
  persist for anyone who doesn't opt in.

**3. Status quo, documented** - keep the five regexes, document the known
gaps and FP classes explicitly (this document, plus a `docs/checks.md`
cross-reference), no new dependency.

- Pro: no work, no new dependency, no fail-open surface added anywhere.
- Con: the measured 5/10 class coverage and the reproduced `.next`-style FP
  leave real gaps in place indefinitely. AWS keys, GCP service-account JSON
  (only caught here incidentally via the private-key regex, not by design -
  a GCP JSON blob without an embedded PEM header would slip through
  entirely, and switching to gitleaks does **not** close this specific gap
  either: gitleaks' GCP hit is the same PEM-dependent incidental match, not
  a dedicated detector - re-running gitleaks against the corpus fixture with
  the `private_key` field redacted produced 0 findings; only trufflehog's
  dedicated `GCP` detector catches the PEM-less case), Stripe keys, Slack
  tokens, and JWTs stay undetected by design, not by measured tradeoff.

## Recommendation

**Augment (path 2).** The measurement supports the task brief's initial
lean, but not unconditionally: gitleaks measurably outperforms the in-tree
regexes on class coverage (9/10 vs. 5/10). Precision is not as clean a
tie-breaker as coverage: raw FP counts favor gitleaks (3 vs. 4 in this
corpus), but that comparison is not apples-to-apples - in production the
in-tree tool already excludes `.next`/`.cache`/etc. via `SKIP_DIRS`, so its
production-equivalent FP count on this corpus is 1 (only the placeholder
edge case), not 4, while gitleaks, run without the equivalent exclude
config, stays at 3. Under that fairer comparison precision favors the
in-tree tool (1 vs. 3), not gitleaks. So the case for path 2 rests on
coverage, not precision: path 3's "no work" option leaves a real, measured
coverage gap on the table rather than a merely theoretical one. But path 1's
fail-open-by-necessity is a regression on this specific tool's core promise
- a check whose entire
design pitch is git-aware `fail`-blocking must not silently downgrade to
"nothing ran" when a binary is absent from `PATH`. Path 2 lets an operator
buy gitleaks' materially better coverage without weakening the default for
everyone who has not opted in, which is the one property worth protecting
here over raw coverage gains.

## Follow-up scope

Not implemented in this task; formulated as a task candidate for a
follow-up:

- Add `secretDetection.scanner?: "regex" | "gitleaks"` (default `"regex"`,
  i.e. today's behavior unchanged) to `PreflightConfig`, alongside the
  existing `secretAllowlist` / `secretDetectionStrict` fields in `src/types.ts`.
- When `scanner: "gitleaks"` is set: locate `gitleaks` on `PATH` (or a
  configurable `commands.gitleaksPath`, matching the `commands.*` override
  convention `docs/checks.md` already documents), run `gitleaks dir <path>
  -f json` (the `dir` subcommand - aliases `dir`/`file`/`directory` - is
  gitleaks' current non-git directory scan entry point; the `gitleaks
  detect --no-git` form used during this investigation still works in
  8.30.1 but is undocumented/hidden from `--help`, so build against `dir`),
  and merge its findings into the existing `Finding[]` pipeline so the
  current diff-scoped / `.md` / gitignored severity logic in
  `runSecretDetection` applies uniformly.
- Missing `gitleaks` binary in opt-in mode is a `limitation` (documented
  degraded run, matching the existing `limitations` pattern), not a
  crash - this is opt-in, so document the exact wording an operator sees.
- Reuse the `.next`/`.cache`/etc. `SKIP_DIRS` list to generate a
  `.gitleaks.toml` config passed via `--config` (`[extend] useDefault =
  true` plus an `[allowlist] paths = [...]` regex exclude per `SKIP_DIRS`
  entry), not a `.gitleaksignore` file - `.gitleaksignore` entries are match
  fingerprints, not paths, and do not suppress path-based FPs (verified in
  this investigation; see [Results](#results)). This gives the external
  scanner the same FP mitigation the in-tree walk's `scanDir` already has,
  instead of reintroducing the original 2026-05-18 `.next/` false positives
  via a different code path.
- Residual gap in the recommended option: opting into gitleaks does not
  close the GCP service-account gap either. gitleaks' GCP "hit" is the same
  PEM-dependent `private-key` rule match the in-tree regex makes, not a
  dedicated detector - a GCP service-account JSON without an embedded PEM
  block slips past both. Only trufflehog's dedicated `GCP` detector catches
  that case (see the trufflehog recommendation below), so this specific gap
  persists under the recommended path 2 unless the follow-up owner also
  reconsiders trufflehog for that reason specifically.
- trufflehog is not recommended as the opt-in target given the measured
  8-9x binary size and ~10x fixed startup cost versus gitleaks, for weaker
  generic-pattern coverage in this corpus; gitleaks is the stronger
  opt-in default. This is a judgment call worth re-checking if the
  follow-up task owner wants trufflehog's specific service-detector breadth
  (e.g. verified-credential checking against live APIs) for a use case this
  investigation didn't test.
- Add integration tests exercising the new config path with a temp
  `.gitleaks.toml`/corpus fixture (skip cleanly when `gitleaks` is not on
  `PATH`, matching the existing "tool not installed" skip pattern used by
  the other checks per `docs/checks.md`).
- Update `docs/checks.md`'s secret-detection row and behavior notes once the
  scanner option exists.

## Appendix: corpus and raw output summary

Corpus and scanner binaries were built and run entirely in the scratchpad
(`/private/tmp/.../scratchpad/corpus/`, `/private/tmp/.../scratchpad/scanners/`),
outside this repository, and are not part of this commit. Summary of what
was in each corpus file (all values synthetic/generated, not real
credentials):

**TP corpus (`corpus/tp/`)**

| File | Class |
|---|---|
| `01-aws-access-key.txt` | AWS access key ID (`AKIA...`) + secret key, shell `export` style |
| `02-github-pat-classic.txt` | GitHub classic PAT (`ghp_` + 36 chars), env var + curl header |
| `03-github-pat-finegrained.txt` | GitHub fine-grained PAT (`github_pat_` + 82 chars) |
| `04-stripe-live-key.txt` | Stripe secret key (`sk_live_...`) |
| `05-slack-bot-token.txt` | Slack bot token (`xoxb-...`) |
| `06-jwt.txt` | Structurally valid HS256 JWT (the well-known jwt.io sample payload) |
| `07-gcp-service-account.json` | Full GCP service-account JSON with an embedded (locally-generated, non-functional) private key |
| `08-rsa-private-key.pem` | Real 2048-bit RSA key pair generated locally with `openssl genrsa -traditional`, used only as scanner input |
| `09-generic-password.txt` | Two `password =` / `password:` assignments |
| `10-generic-api-key.txt` | Two `api_key =` / `apiKey:` assignments (Stripe-test-key-shaped and 40-hex-char-shaped) |

**FP corpus (`corpus/fp/`)**

| File | Content |
|---|---|
| `01-placeholders.txt` | `.env.example`-style placeholders: `YOUR_API_KEY_HERE`, `your_stripe_secret_key`, `<your_slack_bot_token>`, `placeholder-do-not-use-in-prod`, and one `example-password-please-change` value that is designed to probe the edge of `PLACEHOLDER_PATTERNS`'s `example[_-]?key` rule |
| `02-next-build-output.js` | Synthetic minified webpack/Next.js chunk with `token`/`secret`/`apiKey` variables assigned to long hash-like strings, mirroring the 2026-05-18 project-forge FP |
| `03-lockfile-integrity.txt` | npm-lockfile-style block with `integrity: "sha512-..."` hashes |
| `04-test-fixture.test.ts` | `*.test.ts` fixture with fake token/password strings inside test assertions |

Raw scanner outputs (`intree-tp.json`, `intree-fp.json`, `gitleaks-tp.json`,
`gitleaks-fp.json`, `trufflehog-tp.json`, `trufflehog-fp.json`) and the
downloaded release archives were kept in the scratchpad for this
investigation and are not checked into the repository; the tables above are
the complete extraction of their relevant content.
