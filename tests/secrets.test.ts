import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runSecretDetection } from "../src/checks/secrets.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** `git init` a fixture dir so secret-detection's git-aware tiering runs. */
function gitInit(dir: string): void {
  // `-b main` names the initial branch explicitly, which also silences
  // git's "using 'master' as the name" hint in test output.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
}

const REAL_SECRET = "abcdefghijklmnopqrstuvwxyz123456"; // 32 chars, trips the heuristics

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runSecretDetection — git-aware severity", () => {
  it("fails on a secret in a tracked/committable source file", async () => {
    const repoPath = makeTempDir("preflight-secrets-tracked-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    // No .gitignore: src/leaked.js is untracked-but-not-ignored, so it
    // can still be committed and pushed — a hard blocker.
    fs.writeFileSync(
      path.join(repoPath, "src", "leaked.js"),
      `const secret = "${REAL_SECRET}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/leaked.js:1");
  });

  it("warns (does not fail) on a secret in a gitignored, untracked file", async () => {
    const repoPath = makeTempDir("preflight-secrets-gitignored-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(repoPath, ".env"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(repoPath);

    // A gitignored .env holding real credentials is the normal, correct
    // state — it cannot leak via git, so it must not block.
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.details?.[0]).toContain(".env:1");
  });

  it("fails on a secret in a TRACKED file even when a .gitignore rule matches it", async () => {
    // The load-bearing guarantee: `git check-ignore` (without --no-index)
    // never lists a tracked file, so a secret force-added into an
    // otherwise-gitignored file is still a hard blocker. This is the
    // precise regression a switch to `--no-index` would introduce.
    const repoPath = makeTempDir("preflight-secrets-tracked-ignored-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(repoPath, ".env"), `API_KEY="${REAL_SECRET}"\n`);
    // -f: force-add a file that a .gitignore rule would otherwise exclude.
    execFileSync("git", ["add", "-f", ".env"], { cwd: repoPath, stdio: "ignore" });

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("warns (not fails) when the directory is not a git repository", async () => {
    const repoPath = makeTempDir("preflight-secrets-nongit-");
    fs.writeFileSync(path.join(repoPath, ".env"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(repoPath);

    // No git → the git→remote leak model does not apply.
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.limitations.some((l) => l.includes("not a git repository"))).toBe(true);
  });

  it("warns (not fails) on a secret in a .md documentation file", async () => {
    const repoPath = makeTempDir("preflight-secrets-md-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "SETUP.md"),
      `Set your token like: \`token: "${REAL_SECRET}"\`\n`,
    );

    const result = await runSecretDetection(repoPath);

    // Doc example tokens are overwhelmingly placeholders → never a blocker.
    expect(result.checks[0]?.status).toBe("warn");
  });

  it("still detects a real secret when trailing line text contains placeholder words (#32)", async () => {
    // The old line-wide `(?!.*(?:example|here|todo))` negative lookahead let
    // a genuine secret through whenever a comment later on the line happened
    // to contain one of those words. Placeholder filtering is now scoped to
    // the matched value, so trailing prose can no longer suppress a hit.
    const repoPath = makeTempDir("preflight-secrets-trailing-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "src.ts"),
      `const apiKey = "${REAL_SECRET}"; // example value, fill in here, todo\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src.ts:1");
  });

  it("detects a private key in a .key file (extension denylist, not allowlist) (#34)", async () => {
    // .key is not on the old text-extension allowlist, so the file was never
    // even read. The scanner is now a binary-extension denylist: every
    // non-binary file is scanned, so credential formats are covered.
    const repoPath = makeTempDir("preflight-secrets-keyfile-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "server.key"),
      "-----BEGIN PRIVATE KEY-----\nMIIabcdefghijklmnopqrstuvwxyz0123456789\n-----END PRIVATE KEY-----\n",
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("server.key:1");
  });

  it("scans extensionless credential files such as id_rsa (#34)", async () => {
    const repoPath = makeTempDir("preflight-secrets-idrsa-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "id_rsa"),
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabcdefghijklmnopqrstuvwxyz0123456789\n-----END RSA PRIVATE KEY-----\n",
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("id_rsa:1");
  });
});

describe("runSecretDetection — test-fixture heuristic (agent-tasks b31065cc)", () => {
  it("warns (does not fail) on an obvious test-fixture constant under tests/, even when this branch introduces it", async () => {
    // The real dogfood case: TOKEN = "test-planforge-bot-token" in
    // scaffoldkit's tests/test_notify_planforge.py blocked a push over an
    // obvious test fixture.
    const repoPath = makeTempDir("preflight-secrets-fixture-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "test_notify_planforge.py"),
      'TOKEN = "test-planforge-bot-token"\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.details?.[0]).toContain("tests/test_notify_planforge.py:1");
  });

  it("also downgrades dummy-/fake-prefixed fixture values under tests/", async () => {
    const repoPath = makeTempDir("preflight-secrets-fixture-prefixes-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "test"));
    fs.writeFileSync(
      path.join(repoPath, "test", "config.ts"),
      'const apiKey = "dummy_1234567890abcdefghij";\nconst secret = "fake-1234567890abcdefghij";\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("warn");
  });

  it("NEGATIVE CONTROL: still fails on a realistic-looking secret outside any test/tests directory", async () => {
    const repoPath = makeTempDir("preflight-secrets-fixture-negctrl-outside-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const token = "${REAL_SECRET}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("NEGATIVE CONTROL: still fails on a realistic-looking (non-fixture-prefixed) secret INSIDE tests/", async () => {
    // Being under tests/ alone is not enough — the value must also look
    // like an obvious fixture, or a real leaked credential in a test
    // fixture file would be masked.
    const repoPath = makeTempDir("preflight-secrets-fixture-negctrl-inside-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "test_leak.py"),
      `TOKEN = "${REAL_SECRET}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("tests/test_leak.py:1");
  });

  it("does not downgrade a test-/dummy-/fake-prefixed value that lives outside test/tests (prefix alone is not enough)", async () => {
    const repoPath = makeTempDir("preflight-secrets-fixture-negctrl-prefix-only-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "config.ts"),
      'const token = "test-planforge-bot-token";\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("NEGATIVE CONTROL: still fails on a real password under tests/ whose value merely contains an INNER ':test-' (review finding 1)", async () => {
    // Reviewer-measured false negative on the pre-fix unanchored
    // TEST_FIXTURE_VALUE_PATTERN: it searched the whole matched text for
    // ANY `:`/`=` followed by a fixture-looking prefix, so a value with an
    // inner separator matched on the embedded `:test-` fragment and was
    // downgraded to `warn` — masking a real leaked password. The pattern
    // is now anchored to the FIRST separator (the actual assignment), so
    // only the real value is examined.
    const repoPath = makeTempDir("preflight-secrets-fixture-negctrl-inner-sep-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "config.ts"),
      'password = "db://u:S3cretPr0d:test-1"\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("tests/config.ts:1");
  });

  it("NEGATIVE CONTROL: still fails on a genuine ghp_ token under tests/ even when the value is 'test-' prefixed (review finding 2)", async () => {
    // Reviewer-measured false negative: SECRET_PATTERNS is checked in order
    // and scanDir stops at the first match per line. `TOKEN = "test-ghp_..."`
    // trips the earlier, weaker `(?:secret|token)\s*[:=]...` pattern first,
    // so the high-confidence ghp_ pattern a few entries later was never
    // even consulted, and the test-fixture heuristic downgraded a real
    // GitHub token dressed up with a "test-" prefix to a non-blocking warn.
    // A high-confidence credential SHAPE anywhere on the line must now
    // force testFixture:false regardless of which pattern actually won.
    const repoPath = makeTempDir("preflight-secrets-fixture-negctrl-ghp-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "leak.py"),
      `TOKEN = "test-ghp_${"x".repeat(36)}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("tests/leak.py:1");
  });

  it("NEGATIVE CONTROL: a file merely NAMED 'tests' (not a directory) does not get the test-fixture downgrade (isTestPath LOW finding)", async () => {
    // isTestPath() previously checked every path segment, including the
    // file's own basename — so an extensionless file literally named
    // `tests` (e.g. `bin/tests`) counted as "under a test directory" purely
    // because its filename matched, even though it lives directly in
    // `bin/`. Only directory segments should count.
    const repoPath = makeTempDir("preflight-secrets-fixture-negctrl-filename-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "bin"));
    fs.writeFileSync(
      path.join(repoPath, "bin", "tests"),
      'TOKEN = "test-planforge-bot-token"\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("bin/tests:1");
  });
});

describe("runSecretDetection — AWS credential patterns (agent-tasks 211f559c)", () => {
  // AWS's own canonical documentation example access key ID (widely
  // published, not a real credential — the exact value AWS's own docs use
  // as the generic access-key-ID placeholder). Built via concatenation,
  // matching this file's existing `"x".repeat(36)` ghp_ fixture convention,
  // rather than one unbroken literal.
  const AWS_EXAMPLE_ACCESS_KEY_ID = "AKIA" + "IOSFODNN7EXAMPLE"; // 20 chars, matches AKIA[0-9A-Z]{16}
  // A synthetic, non-placeholder-looking 40-char base64-ish value for the
  // secret-access-key pattern. Deliberately NOT AWS's own canonical example
  // secret value (`wJalrXUtn...EXAMPLEKEY`): that literal ends in
  // "EXAMPLEKEY", which trips the pre-existing PLACEHOLDER_PATTERNS
  // `example[_-]?key` filter and gets correctly dropped as an obvious
  // placeholder — a separate, unrelated mechanism this task does not touch.
  const AWS_SECRET_ACCESS_KEY_VALUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 40 chars

  it("fails on a bare AWS access key ID (AKIA + 16 uppercase alphanumeric chars)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const accessKeyId = "AKIA${"X".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("blocks AWS's own canonical docs example access key ID — no exemption for canonical/example values (deliberate decision)", async () => {
    // Decision (see the SECRET_PATTERNS / HIGH_CONFIDENCE_PATTERNS comments
    // in src/checks/secrets.ts): AWS's canonical documentation example
    // access key ID is NOT exempted. It matches AKIA[0-9A-Z]{16} exactly
    // like a real access key ID and is high-confidence, so it blocks just
    // like a genuine one would — the same hard-line treatment the existing
    // ghp_/PEM patterns already get, neither of which carries an
    // example-value exemption either. An operator who deliberately wants
    // this literal committed (e.g. in a docs snippet) has `secretAllowlist`
    // or the inline `pragma: allowlist secret` comment.
    const repoPath = makeTempDir("preflight-secrets-aws-example-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const accessKeyId = "${AWS_EXAMPLE_ACCESS_KEY_ID}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("fails on an AWS_SECRET_ACCESS_KEY-style assignment (identifier + 40-char base64-ish value)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-secret-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const awsSecretAccessKey = "${AWS_SECRET_ACCESS_KEY_VALUE}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("still fails on a test-/dummy-/fake-prefixed value under tests/ when the line also carries a high-confidence AWS access key shape (mirrors the ghp_ negative control)", async () => {
    // Same false-negative class the HIGH_CONFIDENCE_PATTERNS mechanism (PR
    // #57 / agent-tasks b31065cc) already fixed for ghp_: SECRET_PATTERNS is
    // checked in order and scanDir stops at the first match per line, so
    // `TOKEN = "test-AKIA..."` trips the earlier, weaker
    // `(?:secret|token)\s*[:=]...` pattern first. The line-wide
    // HIGH_CONFIDENCE_PATTERNS re-check must still find the AKIA shape and
    // force testFixture:false, so this still blocks under tests/.
    const repoPath = makeTempDir("preflight-secrets-aws-akia-fixture-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "leak.py"),
      `TOKEN = "test-${AWS_EXAMPLE_ACCESS_KEY_ID}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("tests/leak.py:1");
  });

  it("does NOT flag an arbitrary 40-char base64-ish value with no AWS-style key name on the line (anchoring negative control)", async () => {
    // The AWS secret-access-key pattern must stay anchored to an AWS-ish
    // identifier, not fire on any 40-char base64-ish string.
    const repoPath = makeTempDir("preflight-secrets-aws-negctrl-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "hash.ts"),
      `const buildHash = "${AWS_SECRET_ACCESS_KEY_VALUE}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });
});

describe("runSecretDetection — AWS credential pattern hardening (fix-round, agent-tasks 211f559c review)", () => {
  // Same value fixture as the describe block above, redefined locally so
  // this block reads standalone.
  const AWS_SECRET_ACCESS_KEY_VALUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 40 chars

  // --- F1: quoted-key identifier (assignment pattern) ---------------------

  it("F1: detects a quoted-key JSON serialization of the AWS secret access key assignment (`\"aws_secret_access_key\": \"<40 chars>\"`)", async () => {
    // Reviewer-measured miss: the identifier previously had to be
    // followed immediately by `\s*[:=]`, so a JSON/quoted-YAML
    // serialization — where a closing quote sits between the identifier
    // and the separator — produced zero findings.
    const repoPath = makeTempDir("preflight-secrets-aws-json-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.json"),
      `{\n  "aws_secret_access_key": "${AWS_SECRET_ACCESS_KEY_VALUE}"\n}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.json:2");
  });

  it("F1 lock: does NOT match a 39-char AWS secret-access-key value ({40} is a fixed width, not a minimum)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-secret-39-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    const value39 = AWS_SECRET_ACCESS_KEY_VALUE.slice(0, 39);
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const awsSecretAccessKey = "${value39}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- F2: AKIA boundary-anchoring ------------------------------------------

  it("F2: does NOT flag AKIA merely embedded inside a longer uppercase/digit run (e.g. a base32-style build hash)", async () => {
    // Reviewer-measured false positive: the previously unanchored
    // AKIA[0-9A-Z]{16} pattern matched anywhere `AKIA` + 16 [0-9A-Z]
    // chars occurred, even mid-run inside a longer blob with no
    // standalone AWS access-key-id shape — and because AKIA is
    // high-confidence, such a hit was a hard, non-downgradable block.
    const repoPath = makeTempDir("preflight-secrets-aws-akia-embedded-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "build-id.ts"),
      `const buildChecksum = "ZZZAKIA1234567890ABCDEFZZZZZZZZZZZZZZZZZZZZZZZZZZ";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("F2 lock (round 2, agent-tasks 9ef05069): does NOT flag AKIA immediately preceded by an uppercase letter, isolating the LEADING boundary independent of the trailing one", async () => {
    // The F2 fixture above conflates both boundaries (AKIA is both
    // preceded AND followed by extra uppercase/digit chars), so it does
    // not, by itself, prove the LEADING `(?<![A-Z0-9])` lookbehind is
    // doing any work: a mutation that drops only the lookbehind and
    // leaves the trailing `(?![A-Z0-9])` lookahead intact still passes
    // that fixture, because the trailing boundary independently blocks
    // it. This fixture isolates the leading side: AKIA is preceded by
    // uppercase letters (violates only the lookbehind) but immediately
    // followed by a closing quote, not another uppercase/digit char (the
    // lookahead is satisfied either way) — so this can only pass because
    // the lookbehind is doing its own, independent job.
    const repoPath = makeTempDir("preflight-secrets-aws-akia-leading-boundary-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "build-id.ts"),
      `const buildChecksum = "ZZZAKIA${"1".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("F2 lock: does NOT match a lowercase 'akia...' or an 'AKIA' prefix with a lowercase 16-char tail (case-sensitive by design)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-case-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "lower.ts"),
      [
        `const lowerFull = "akia${"x".repeat(16)}";`,
        `const lowerTail = "AKIA${"x".repeat(16)}";`,
        "",
      ].join("\n"),
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("F2 verification: still matches AKIA... in a URL query-string form (e.g. a pre-signed S3 URL's AWSAccessKeyId param)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-url-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const url = "https://bucket.s3.amazonaws.com/key?AWSAccessKeyId=AKIA${"X".repeat(16)}&Expires=1234567890";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("F2 verification: still matches AKIA... as a bare JSON string value (e.g. `\"accessKeyId\": \"AKIA...\"`)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-json-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.json"),
      `{\n  "accessKeyId": "AKIA${"X".repeat(16)}"\n}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("F2 verification: still matches AKIA... bare in prose with no surrounding code/quotes", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-prose-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "notes.txt"),
      `Rotate the leaked key AKIA${"X".repeat(16)} immediately.\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("F2 axis interaction lock: an AKIA finding in a .md file still downgrades to warn (non-blocking) — the .md tier applies even to a high-confidence match", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-md-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "README.md"),
      `Example: \`const accessKeyId = "AKIA${"X".repeat(16)}"\`\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.details).toContain("README.md:1 (non-blocking)");
  });

  // --- F3: the fixture downgrade is structurally unreachable for the
  //     AWS secret-access-key assignment pattern ---------------------------

  it("F3 lock: still fails (does not downgrade to warn) on an aws_secret_access_key value starting with the word 'test' under tests/ — the fixture downgrade is structurally unreachable for this pattern", async () => {
    // TEST_FIXTURE_VALUE_PATTERN requires `test`/`dummy`/`fake`
    // immediately followed by `-`/`_` right after the separator; this
    // pattern's value charset ([A-Za-z0-9/+=]) has no `-`/`_`, so a
    // value that merely starts with the literal word "test" (no
    // separator) never satisfies TEST_FIXTURE_VALUE_PATTERN and must
    // still block, even under tests/.
    const repoPath = makeTempDir("preflight-secrets-aws-secret-testword-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    const value = "test" + "A".repeat(36); // 40 chars, no '-'/'_' right after "test"
    fs.writeFileSync(
      path.join(repoPath, "tests", "fixture.ts"),
      `const awsSecretAccessKey = "${value}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("tests/fixture.ts:1");
  });

  // --- Missing-test lock: placeholder-pattern interaction -------------------

  it("pins current behavior: AWS's own canonical docs secret-access-key example value (ends in EXAMPLEKEY) is dropped by the pre-existing PLACEHOLDER_PATTERNS filter, not this task's patterns", async () => {
    // So a later, unrelated PLACEHOLDER_PATTERNS edit flips this test
    // instead of silently changing behavior. This test does not touch
    // PLACEHOLDER_PATTERNS.
    const repoPath = makeTempDir("preflight-secrets-aws-secret-placeholder-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    const AWS_DOCS_EXAMPLE_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY"; // 40 chars, AWS's own docs example
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const awsSecretAccessKey = "${AWS_DOCS_EXAMPLE_SECRET_ACCESS_KEY}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });
});

describe("runSecretDetection — AWS credential coverage round 2 (agent-tasks 9ef05069, R1 reviewer probe of 211f559c)", () => {
  const AWS_SECRET_ACCESS_KEY_VALUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 40 chars
  // Same "docs example" suffix convention as AWS_EXAMPLE_ACCESS_KEY_ID
  // above, prefixed with ASIA (STS temporary credentials) instead of AKIA.
  const ASIA_EXAMPLE_ACCESS_KEY_ID = "ASIA" + "IOSFODNN7EXAMPLE"; // 20 chars

  // --- ASIA prefix (STS temporary credentials) -----------------------------

  it("fails on a bare ASIA access key ID (STS temporary credential, same shape as AKIA)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-asia-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const accessKeyId = "ASIA${"X".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("still fails on a test-/dummy-/fake-prefixed value under tests/ when the line carries a high-confidence ASIA shape (mirrors the AKIA fixture negative control)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-asia-fixture-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "leak.py"),
      `TOKEN = "test-${ASIA_EXAMPLE_ACCESS_KEY_ID}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("tests/leak.py:1");
  });

  it("does NOT match a lowercase 'asia...' (case-sensitive by design, same as AKIA's F2 lock)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-asia-case-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "config.ts"),
      `const lowerTail = "asia${"x".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- End-to-end: aws sts assume-role output JSON -------------------------

  it("detects a committed `aws sts assume-role` output JSON end to end (ASIA access key ID + SecretAccessKey, through the public check entry point)", async () => {
    // This is the exact miss called out by the R1 reviewer: before
    // 211f559c-R2 neither line matched at all; after 211f559c-R2 the AKIA
    // fix covers a long-lived key but `aws sts assume-role` always mints an
    // ASIA-prefixed temporary key, so the AccessKeyId line was still
    // undetected. Combined with the round-2 secretAccessKey identifier fix
    // below, both lines of this realistic, copy-pasted CLI output must now
    // block.
    const repoPath = makeTempDir("preflight-secrets-aws-sts-assume-role-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "sts-output.json"),
      [
        "{",
        '  "Credentials": {',
        `    "AccessKeyId": "${ASIA_EXAMPLE_ACCESS_KEY_ID}",`,
        `    "SecretAccessKey": "${AWS_SECRET_ACCESS_KEY_VALUE}",`,
        '    "Expiration": "2026-08-24T00:00:00Z"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/sts-output.json:3");
    expect(result.checks[0]?.details).toContain("src/sts-output.json:4");
  });

  // --- Identifier variant: secretAccessKey (AWS JS SDK camelCase) ----------

  it("identifier variant: fails on `secretAccessKey` (AWS JS SDK field name, no 'aws' prefix)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-jssdk-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "client.ts"),
      `const secretAccessKey = "${AWS_SECRET_ACCESS_KEY_VALUE}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/client.ts:1");
  });

  it("identifier variant FP-negative: does NOT fail on `secretAccessKey` with a 39-char value ({40} stays a fixed width for this identifier too)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-jssdk-fp-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "client.ts"),
      `const secretAccessKey = "${AWS_SECRET_ACCESS_KEY_VALUE.slice(0, 39)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- Identifier variant: secret_access_key (boto) -------------------------

  it("identifier variant: fails on `secret_access_key` (boto/AWS CLI config field name, no 'aws' prefix)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-boto-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "credentials.ini"),
      `secret_access_key = ${AWS_SECRET_ACCESS_KEY_VALUE}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/credentials.ini:1");
  });

  it("identifier variant FP-negative: does NOT fail on `secret_access_key` whose value is not 40 charset-conforming chars (e.g. a short placeholder-shaped stand-in)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-boto-fp-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "credentials.ini"),
      "secret_access_key = <REDACTED>\n",
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- Identifier variant: aws_secret_key (Ansible) -------------------------

  it("identifier variant: fails on `aws_secret_key` (Ansible module parameter name, 'aws' + 'key', no 'access')", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-ansible-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "playbook.yml"),
      `aws_secret_key: "${AWS_SECRET_ACCESS_KEY_VALUE}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/playbook.yml:1");
  });

  it("identifier variant FP-negative: does NOT fail on `aws_secret_key` referencing an Ansible Vault lookup (no literal 40-char value on the line)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-ansible-fp-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "playbook.yml"),
      "aws_secret_key: \"{{ vault_aws_secret_key }}\"\n",
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- Identifier variant: secret_key (Terraform, bare, broadest name) -----

  it("identifier variant: fails on bare `secret_key` (Terraform's conventional variable name for this credential) with a 40-char base64-ish value", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-var-tf-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "main.tf"),
      `secret_key = "${AWS_SECRET_ACCESS_KEY_VALUE}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/main.tf:1");
  });

  it("identifier variant FP-negative: does NOT fail on a Django-style `SECRET_KEY` (same broad identifier, different value shape — the documented collision risk)", async () => {
    // Django's default SECRET_KEY generator draws from an alphabet that
    // includes `-`/`_`/`!`/`@`/etc., which fall outside this pattern's
    // `[A-Za-z0-9/+=]` value charset — a real Django value breaks the
    // charset run almost immediately. This fixture uses the common
    // `django-insecure-` prefix convention (Django's own `startproject`
    // scaffold marks dev-only keys this way) to demonstrate the break.
    const repoPath = makeTempDir("preflight-secrets-aws-var-django-fp-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "settings.py"),
      `SECRET_KEY = "django-insecure-${"x".repeat(40)}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- Generic quoted-key blind spot (api_key / token / password) ----------

  it("generic pattern quoted-key fix: detects a quoted-key JSON `\"api_key\": \"<value>\"` (previously missed, same blind spot the AWS assignment pattern had)", async () => {
    const repoPath = makeTempDir("preflight-secrets-generic-apikey-json-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.json"),
      `{\n  "api_key": "${REAL_SECRET}"\n}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.json:2");
  });

  it("generic pattern quoted-key fix: detects a quoted-key JSON `\"token\": \"<value>\"`", async () => {
    const repoPath = makeTempDir("preflight-secrets-generic-token-json-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.json"),
      `{\n  "token": "${REAL_SECRET}"\n}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.json:2");
  });

  it("generic pattern quoted-key fix: detects a quoted-key `'password': '<value>'` (single-quoted Python dict)", async () => {
    const repoPath = makeTempDir("preflight-secrets-generic-password-py-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.py"),
      "creds = {\n  'password': 'some$ecretPassw0rd!',\n}\n",
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.py:2");
  });

  it("generic pattern quoted-key fix: unquoted-key forms are unaffected (`apiKey = \"<value>\"` still detected exactly as before)", async () => {
    // Locks in that adding the optional `["']?` after the identifier did
    // not change unquoted-key behavior: it matches zero characters there.
    const repoPath = makeTempDir("preflight-secrets-generic-apikey-unquoted-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const apiKey = "${REAL_SECRET}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });
});

describe("runSecretDetection — allowlist", () => {
  it("suppresses a finding listed by exact path in secretAllowlist", async () => {
    const repoPath = makeTempDir("preflight-secrets-allow-path-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "demo"));
    fs.writeFileSync(
      path.join(repoPath, "demo", "playground.ts"),
      `const apiKey = "${REAL_SECRET}";\n`,
    );

    const result = await runSecretDetection(repoPath, {
      secretAllowlist: ["demo/playground.ts"],
    });

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });

  it("suppresses a finding listed by path:line in secretAllowlist", async () => {
    const repoPath = makeTempDir("preflight-secrets-allow-line-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "config.ts"),
      `const ok = 1;\nconst apiKey = "${REAL_SECRET}";\n`,
    );

    const result = await runSecretDetection(repoPath, {
      secretAllowlist: ["config.ts:2"],
    });

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("suppresses findings matched by a glob entry", async () => {
    const repoPath = makeTempDir("preflight-secrets-allow-glob-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "fixtures"));
    fs.writeFileSync(
      path.join(repoPath, "fixtures", "keys.ts"),
      `const apiKey = "${REAL_SECRET}";\n`,
    );

    const result = await runSecretDetection(repoPath, {
      secretAllowlist: ["fixtures/*"],
    });

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("suppresses a finding on a line carrying an inline pragma", async () => {
    const repoPath = makeTempDir("preflight-secrets-pragma-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "demo.ts"),
      `const apiKey = "${REAL_SECRET}"; // pragma: allowlist secret\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });
});

describe("runSecretDetection — existing behaviour preserved", () => {
  it("ignores example env templates", async () => {
    const repoPath = makeTempDir("preflight-secrets-example-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".env.example"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("ignores .env.<name>.example files via glob, not just the exact .env.example name (agent-tasks 1ba4a4d1)", async () => {
    const repoPath = makeTempDir("preflight-secrets-env-glob-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, ".env.production.example"),
      `GITHUB_TOKEN=ghp_${"x".repeat(36)}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("filters obvious placeholder values", async () => {
    const repoPath = makeTempDir("preflight-secrets-placeholder-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "src.ts"),
      'const apiKey = "your_api_key_here";\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("skips framework build dirs (.next, .nuxt, .svelte-kit, .cache, .parcel-cache, .turbo)", async () => {
    // Bundlers emit hashed identifier strings that trip SECRET_PATTERNS.
    // The detector must not flag files inside these gitignored, always-
    // rebuildable artifact directories. Includes a nested case
    // (apps/web/.next/...) to lock in that the skip applies at every
    // recursion depth, not just the repo root.
    const repoPath = makeTempDir("preflight-secrets-build-dirs-");
    gitInit(repoPath);
    const fakeSecret = `secret: "${REAL_SECRET}"\n`;
    const dirs = [
      path.join(".next", "server", "chunks"),
      ".nuxt",
      path.join(".svelte-kit", "output"),
      ".cache",
      ".parcel-cache",
      ".turbo",
      path.join("apps", "web", ".next"),
    ];
    for (const dir of dirs) {
      const full = path.join(repoPath, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, "bundled.js"), fakeSecret);
    }

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });
});

describe("runSecretDetection — diff-scoped severity", () => {
  /** Stage everything and commit with a fixed identity (no global config). */
  function gitCommit(dir: string, message: string): void {
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c", "user.email=preflight-test@example.com",
        "-c", "user.name=preflight-test",
        "commit", "-q", "-m", message,
      ],
      { cwd: dir, stdio: "ignore" },
    );
  }

  function gitCheckoutNewBranch(dir: string, name: string): void {
    execFileSync("git", ["checkout", "-q", "-b", name], { cwd: dir, stdio: "ignore" });
  }

  it("warns on a pre-existing secret in a file the branch never touched", async () => {
    const repoPath = makeTempDir("preflight-secrets-preexisting-");
    gitInit(repoPath);
    // Base commit on main: legacy.js already carries a secret.
    fs.writeFileSync(path.join(repoPath, "legacy.js"), `const secret = "${REAL_SECRET}";\n`);
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 1;\n");
    gitCommit(repoPath, "base");
    // Feature branch changes only app.js — legacy.js is untouched.
    gitCheckoutNewBranch(repoPath, "feature");
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 2;\n");
    gitCommit(repoPath, "unrelated change");

    const result = await runSecretDetection(repoPath);

    // The secret is real and tracked, but this branch did not introduce
    // or touch it — it must not block an unrelated change.
    expect(result.checks[0]?.status).toBe("warn");
  });

  it("fails on a secret in a file the branch changed", async () => {
    const repoPath = makeTempDir("preflight-secrets-changed-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 1;\n");
    gitCommit(repoPath, "base");
    gitCheckoutNewBranch(repoPath, "feature");
    // This branch edits app.js and the edit adds a secret.
    fs.writeFileSync(path.join(repoPath, "app.js"), `const secret = "${REAL_SECRET}";\n`);
    gitCommit(repoPath, "add feature (with a secret)");

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("app.js:1");
  });

  it("fails on a secret added in an uncommitted working-tree edit", async () => {
    const repoPath = makeTempDir("preflight-secrets-worktree-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 1;\n");
    gitCommit(repoPath, "base");
    gitCheckoutNewBranch(repoPath, "feature");
    // Diverge the feature branch so the merge-base is the base commit
    // (not HEAD) — the diff scope is then a real fork-point comparison.
    fs.writeFileSync(path.join(repoPath, "other.js"), "export const y = 1;\n");
    gitCommit(repoPath, "feature work");
    // Uncommitted edit — `git diff <base>` (base-vs-worktree) catches it.
    fs.writeFileSync(path.join(repoPath, "app.js"), `const secret = "${REAL_SECRET}";\n`);

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("fails on a newly-committed secret when the target is a subdirectory (#33)", async () => {
    // `git diff --name-only` (without `--relative`) emits repo-root-relative
    // paths, but `Finding.file` and `ls-files --others` are relative to the
    // working dir. When the working dir is a subdirectory the diff paths
    // carry a leading subdir prefix that never matches a finding, so every
    // committable secret was silently downgraded to a warn. `--relative`
    // scopes the diff output to the working dir so they line up again.
    const repoPath = makeTempDir("preflight-secrets-subdir-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "service"));
    fs.writeFileSync(path.join(repoPath, "service", "app.js"), "export const x = 1;\n");
    gitCommit(repoPath, "base");
    gitCheckoutNewBranch(repoPath, "feature");
    // The branch commits a secret inside the subdirectory.
    fs.writeFileSync(
      path.join(repoPath, "service", "app.js"),
      `const secret = "${REAL_SECRET}";\n`,
    );
    gitCommit(repoPath, "add secret in subdir");

    // Detection scoped to the subdirectory (workingDir = subdir).
    const result = await runSecretDetection(path.join(repoPath, "service"));

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("app.js:1");
  });

  it("fails on a secret in a new untracked file", async () => {
    const repoPath = makeTempDir("preflight-secrets-newfile-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 1;\n");
    gitCommit(repoPath, "base");
    gitCheckoutNewBranch(repoPath, "feature");
    fs.writeFileSync(path.join(repoPath, "other.js"), "export const y = 1;\n");
    gitCommit(repoPath, "feature work");
    // A brand-new untracked, unignored file is part of this change.
    fs.writeFileSync(path.join(repoPath, "new.js"), `const secret = "${REAL_SECRET}";\n`);

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    // Default diff-scoped mode: a blocking finding IS in a changed file.
    expect(result.checks[0]?.message).toContain("introduced by this change");
  });

  it("fails safe on the default branch with no upstream (merge-base is HEAD)", async () => {
    const repoPath = makeTempDir("preflight-secrets-onmain-");
    gitInit(repoPath);
    // A secret committed straight onto main, no feature branch, no
    // upstream: `merge-base HEAD main` == HEAD, so the diff scope is
    // meaningless. The check must fail safe, not downgrade to warn.
    fs.writeFileSync(path.join(repoPath, "app.js"), `const secret = "${REAL_SECRET}";\n`);
    gitCommit(repoPath, "commit a secret straight onto main");

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    // The diff base is unresolvable, so the finding cannot be attributed
    // to this change; the message uses neutral wording.
    expect(result.checks[0]?.message).toContain("in committable file(s)");
    expect(result.checks[0]?.message).not.toContain("introduced by this change");
  });

  it("secretDetectionStrict re-blocks a pre-existing untouched finding and uses neutral wording", async () => {
    const repoPath = makeTempDir("preflight-secrets-strict-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "legacy.js"), `const secret = "${REAL_SECRET}";\n`);
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 1;\n");
    gitCommit(repoPath, "base");
    gitCheckoutNewBranch(repoPath, "feature");
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 2;\n");
    gitCommit(repoPath, "unrelated change");

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    // Strict mode opts out of diff-scoping: every committable finding fails.
    expect(result.checks[0]?.status).toBe("fail");
    // The finding is pre-existing, not introduced by this branch, so the
    // message uses neutral wording rather than "introduced by this change".
    expect(result.checks[0]?.message).toContain("in committable file(s)");
    expect(result.checks[0]?.message).not.toContain("introduced by this change");
  });
});

describe("runSecretDetection — default branch with no divergence (agent-tasks 1ba4a4d1)", () => {
  function commit(dir: string, message: string): void {
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c", "user.email=preflight-test@example.com",
        "-c", "user.name=preflight-test",
        "commit", "-q", "-m", message,
      ],
      { cwd: dir, stdio: "ignore" },
    );
  }

  /**
   * Simulate a real `git clone`: seed a bare "remote" with one commit on
   * `master`, then clone it into a fresh directory. The clone's local
   * `master` tracks `origin/master` and sits exactly on it (upstream
   * configured, zero divergence) — the precise shape of the dogfood bug
   * (agent-ops-dashboard checked out on `origin/master` untouched).
   */
  function makeFreshClone(
    fileName: string,
    content: string,
    extraBaseFiles: Record<string, string> = {},
  ): string {
    const remoteDir = makeTempDir("preflight-secrets-remote-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "master"], {
      cwd: remoteDir,
      stdio: "ignore",
    });

    const seedDir = makeTempDir("preflight-secrets-seed-");
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: seedDir, stdio: "ignore" });
    fs.writeFileSync(path.join(seedDir, fileName), content);
    for (const [extraName, extraContent] of Object.entries(extraBaseFiles)) {
      fs.writeFileSync(path.join(seedDir, extraName), extraContent);
    }
    commit(seedDir, "base");
    execFileSync("git", ["remote", "add", "origin", remoteDir], {
      cwd: seedDir,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "-q", "origin", "master"], { cwd: seedDir, stdio: "ignore" });

    const cloneParent = makeTempDir("preflight-secrets-clone-parent-");
    const cloneDir = path.join(cloneParent, "clone");
    execFileSync("git", ["clone", "-q", remoteDir, cloneDir], { stdio: "ignore" });
    return cloneDir;
  }

  it("warns (does not fail) on a secret in a committed file when a fresh clone sits untouched on the default branch", async () => {
    const cloneDir = makeFreshClone("config.js", `const secret = "${REAL_SECRET}";\n`);

    const result = await runSecretDetection(cloneDir);

    // The clone has not diverged from origin/master at all: this is the
    // correct "empty diff" case, not an unresolvable one. The pre-existing
    // finding must warn, never fail, and must not fall back to the
    // fail-safe "could not resolve a diff base" path.
    expect(result.checks[0]?.status).toBe("warn");
    expect(
      result.limitations.some((l) => l.includes("could not resolve a diff base")),
    ).toBe(false);
  });

  it("still fails on a secret introduced by an UNCOMMITTED edit while HEAD sits on the default branch", async () => {
    const cloneDir = makeFreshClone("config.js", "export const x = 1;\n");
    // Uncommitted edit on the default branch itself (no divergence from
    // origin/master in terms of commits, but the working tree changed).
    fs.writeFileSync(path.join(cloneDir, "config.js"), `const secret = "${REAL_SECRET}";\n`);

    const result = await runSecretDetection(cloneDir);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.message).toContain("introduced by this change");
    // Structural signal, independent of message wording: this must resolve
    // through the "trusted, not diverged" path (base == HEAD), not fall
    // back to the unresolvable-diff-base fail-safe.
    expect(
      result.limitations.some((l) => l.includes("could not resolve a diff base")),
    ).toBe(false);
  });

  it("fails on a NEW untracked-and-unignored secret file on a non-diverged default branch (base == HEAD path)", async () => {
    const cloneDir = makeFreshClone("app.js", "export const x = 1;\n");
    // A brand-new file that was never part of the clone's base commit and
    // carries no .gitignore rule: untracked-and-unignored, so it is part
    // of "this change" even though the branch itself has not diverged.
    fs.writeFileSync(path.join(cloneDir, "leaked.js"), `const secret = "${REAL_SECRET}";\n`);

    const result = await runSecretDetection(cloneDir);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("leaked.js:1");
    expect(
      result.limitations.some((l) => l.includes("could not resolve a diff base")),
    ).toBe(false);
  });

  it("warns (does not over-block) on a GITIGNORED untracked secret file on a non-diverged default branch", async () => {
    const cloneDir = makeFreshClone("app.js", "export const x = 1;\n", { ".gitignore": ".env\n" });
    // Untracked AND ignored: cannot leak via git, so it must stay a warn
    // even though the branch has not diverged from the default branch.
    fs.writeFileSync(path.join(cloneDir, ".env"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(cloneDir);

    expect(result.checks[0]?.status).toBe("warn");
  });
});
