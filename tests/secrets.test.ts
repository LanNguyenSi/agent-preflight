import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("does not fail (and does not report) a secret in a gitignored, untracked file", async () => {
    const repoPath = makeTempDir("preflight-secrets-gitignored-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(repoPath, ".env"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(repoPath);

    // A gitignored .env holding real credentials is the normal, correct
    // state — it cannot leak via git, so it must not block. Inside a git
    // work tree the file set comes from git, which never lists it, so it
    // is not even read and produces no warning either.
    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
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

describe("runSecretDetection — test-fixture heuristic", () => {
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

  it("NEGATIVE CONTROL: still fails on a real password under tests/ whose value merely contains an INNER ':test-'", async () => {
    // An unanchored
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

  it("NEGATIVE CONTROL: still fails on a genuine ghp_ token under tests/ even when the value is 'test-' prefixed", async () => {
    // A high-confidence credential shape anywhere on the line prevents
    // the fixture downgrade, even when an earlier assignment pattern
    // matches the same line and the token value starts with "test-".
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

  it("NEGATIVE CONTROL: a file merely NAMED 'tests' (not a directory) does not get the test-fixture downgrade", async () => {
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

describe("runSecretDetection — AWS credential patterns", () => {
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
    // The HIGH_CONFIDENCE_PATTERNS mechanism also protects ghp_ tokens: SECRET_PATTERNS is
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

describe("runSecretDetection — AWS credential pattern hardening", () => {
  // Same value fixture as the describe block above, redefined locally so
  // this block reads standalone.
  const AWS_SECRET_ACCESS_KEY_VALUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 40 chars

  // --- quoted-key identifier (assignment pattern) ---------------------

  it("detects a quoted-key JSON serialization of the AWS secret access key assignment (`\"aws_secret_access_key\": \"<40 chars>\"`)", async () => {
    // JSON and quoted YAML place a closing quote between the identifier
    // and assignment separator; the secret pattern accepts that quote.
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

  it("does NOT match a 39-char AWS secret-access-key value ({40} is a fixed width, not a minimum)", async () => {
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

  // --- AKIA boundary-anchoring ------------------------------------------

  it("does NOT flag AKIA merely embedded inside a longer uppercase/digit run (e.g. a base32-style build hash)", async () => {
    // The high-confidence AKIA pattern requires a standalone key shape;
    // the same substring inside a longer uppercase/digit run is not a key.
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

  it("does NOT flag AKIA immediately preceded by an uppercase letter, isolating the LEADING boundary independent of the trailing one", async () => {
    // The embedded-key fixture above conflates both boundaries (AKIA is both
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

  it("does NOT match a lowercase 'akia...' or an 'AKIA' prefix with a lowercase 16-char tail (case-sensitive by design)", async () => {
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

  it("still matches AKIA... in a URL query-string form (e.g. a pre-signed S3 URL's AWSAccessKeyId param)", async () => {
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

  it("still matches AKIA... as a bare JSON string value (e.g. `\"accessKeyId\": \"AKIA...\"`)", async () => {
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

  it("still matches AKIA... bare in prose with no surrounding code/quotes", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-akia-prose-");
    gitInit(repoPath);
    fs.writeFileSync(
      path.join(repoPath, "notes.txt"),
      `Rotate the leaked key AKIA${"X".repeat(16)} immediately.\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
  });

  it("an AKIA finding in a .md file still downgrades to warn (non-blocking) — the .md tier applies even to a high-confidence match", async () => {
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

  // --- the fixture downgrade is structurally unreachable for the
  //     AWS secret-access-key assignment pattern ---------------------------

  it("still fails (does not downgrade to warn) on an aws_secret_access_key value starting with the word 'test' under tests/ — the fixture downgrade is structurally unreachable for this pattern", async () => {
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

describe("runSecretDetection — AWS credential prefix and identifier coverage", () => {
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

  it("does NOT match a lowercase 'asia...' (case-sensitive by design, same as AKIA's boundary check)", async () => {
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
    // `aws sts assume-role` emits an ASIA-prefixed temporary access key
    // and a SecretAccessKey field. Both credential shapes in this
    // copy-pasted CLI output must block.
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

  // --- Trailing lookahead rejects longer values ---------------------------

  it("trailing lookahead: does NOT match `secret_access_key` when the value is 41+ chars (a 40-char PREFIX of a longer value is not a 40-char AWS secret key)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-lookahead-41-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    const value41 = AWS_SECRET_ACCESS_KEY_VALUE + "Q"; // 41 charset-compatible chars
    fs.writeFileSync(
      path.join(repoPath, "src", "credentials.ini"),
      `secret_access_key = ${value41}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("trailing lookahead (decision C): does NOT match `aws_secret_access_key` when the value is a 216-char base64-ish blob (a long session token/JWT is not a 40-char AWS secret key, same reasoning as the identifier-variant pattern)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-lookahead-216-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    // 216 charset-compatible ([A-Za-z0-9/+=]) characters, no separators —
    // simulates a long STS session token / JWT-shaped blob with the
    // structural `.` separators stripped, so the ONLY thing that could
    // stop a match at 40 chars is the trailing lookahead itself.
    const longValue = "aB3".repeat(72); // 3 * 72 = 216 chars
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const awsSecretAccessKey = "${longValue}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("trailing lookahead positive control: still fails on `aws_secret_access_key` at exactly 40 chars", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-lookahead-40-aws-");
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

  it("trailing lookahead positive control: still fails on `secret_access_key` at exactly 40 chars", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-lookahead-40-noaws-");
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

  // --- Prefix coverage: ABIA / ACCA / A3T (previously untested) ------------

  it("fails on a bare ABIA access key ID (AWS STS service bearer token, e.g. CodeArtifact, same shape as AKIA)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-abia-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const accessKeyId = "ABIA${"X".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("fails on a bare ACCA access key ID (context-specific/imported credential, same shape as AKIA)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-acca-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const accessKeyId = "ACCA${"X".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("fails on a bare A3T access key ID (legacy S3 access-grant prefix, `A3T` + 1 free char + 16-char tail)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-a3t-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const accessKeyId = "A3TZ${"X".repeat(16)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.ts:1");
  });

  it("shared boundary negative: does NOT match an ABIA-prefixed run with 17 trailing uppercase/digit chars (one too many for the fixed 20-char shape)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-abia-boundary-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "build-id.ts"),
      `const buildChecksum = "ABIA${"X".repeat(17)}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  // --- secret_key leading identifier boundary (decision B) -----------------

  it("secret_key leading boundary: does NOT fail on `MY_SECRET_KEY` (a longer identifier ending in secret_key is not this AWS pattern's job)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-secretkey-my-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `const MY_SECRET_KEY = "${AWS_SECRET_ACCESS_KEY_VALUE}";\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("secret_key leading boundary: does NOT fail on `jwt_secret_key` (same reasoning, lowercase/snake_case identifier)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-secretkey-jwt-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.ts"),
      `jwt_secret_key: "${AWS_SECRET_ACCESS_KEY_VALUE}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("secret_key documented 40-hex collision: still fails on standalone `secret_key` assigned a 40-hex value (accepted risk, see src/checks/secrets.ts comment)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-secretkey-hex-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    const hex40 = "f".repeat(40); // openssl rand -hex 20 / git-SHA-1-shaped
    fs.writeFileSync(
      path.join(repoPath, "src", "main.tf"),
      `secret_key = "${hex40}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/main.tf:1");
  });

  it("secret_key CLI flag form: detects `--secret-key=<40 chars>` (CLI flag with hyphen, should be detected)", async () => {
    // The leading lookbehind fix permits a leading hyphen (CLI/YAML dash)
    // while still blocking underscore suffixes (env-var case).
    const repoPath = makeTempDir("preflight-secrets-aws-cli-flag-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.sh"),
      `./script --secret-key="${AWS_SECRET_ACCESS_KEY_VALUE}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.sh:1");
  });

  it("secret_key CLI flag variant: detects `--aws-secret-key=<40 chars>` (aws- prefixed CLI flag)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-cli-flag-aws-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "deploy.sh"),
      `deploy --aws-secret-key="${AWS_SECRET_ACCESS_KEY_VALUE}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/deploy.sh:1");
  });

  it("secret_key YAML dash form: detects `-secret_key: <40 chars>` (YAML list item with leading dash)", async () => {
    const repoPath = makeTempDir("preflight-secrets-aws-yaml-dash-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(
      path.join(repoPath, "src", "config.yml"),
      `- secret_key: "${AWS_SECRET_ACCESS_KEY_VALUE}"\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/config.yml:1");
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

  it("generic pattern quoted-key FP class pin: deliberately blocks a quoted-key `\"token\": \"<40-hex commit SHA>\"` outside tests/ (documented false-positive class, not exempted)", async () => {
    // This shape (a quoted-key JSON/YAML
    // field named api_key/token/secret carrying a fixture-looking value —
    // a commit SHA, a UUID, a recorded header value) is a known false-
    // positive class for OpenAPI specs, Postman collections, and recorded
    // HTTP fixtures. It is deliberately NOT exempted; this pins that
    // choice so a later change does not silently soften it. The escape
    // hatches (secretAllowlist / `pragma: allowlist secret`) remain
    // available for a genuine fixture file.
    const repoPath = makeTempDir("preflight-secrets-generic-token-hexsha-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"));
    const commitSha = "a".repeat(40); // 40-hex, git-SHA-1-shaped
    fs.writeFileSync(
      path.join(repoPath, "src", "recorded-response.json"),
      `{\n  "token": "${commitSha}"\n}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("src/recorded-response.json:2");
  });

  it("generic pattern quoted-key FP class: the tests/-directory fixture downgrade still applies to a quoted-key form with a `test-`-prefixed value", async () => {
    // The FP class above is a deliberate hard block in general, but the
    // pre-existing tests/-fixture downgrade path (TEST_FIXTURE_VALUE_PATTERN
    // + isTestPath) is unaffected by the quoted-key fix: a quoted-key
    // match whose VALUE is itself test-/dummy-/fake-prefixed, under
    // tests/, still downgrades to warn — same as the unquoted forms
    // already covered above in this file.
    const repoPath = makeTempDir("preflight-secrets-generic-token-fixture-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "tests"));
    fs.writeFileSync(
      path.join(repoPath, "tests", "recorded-response.json"),
      `{\n  "token": "test-${"x".repeat(20)}"\n}\n`,
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("warn");
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

  it("ignores .env.<name>.example files via glob, not just the exact .env.example name", async () => {
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

describe("runSecretDetection — default branch with no divergence", () => {
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

  it("does not block (or report) a GITIGNORED untracked secret file on a non-diverged default branch", async () => {
    const cloneDir = makeFreshClone("app.js", "export const x = 1;\n", { ".gitignore": ".env\n" });
    // Untracked AND ignored: cannot leak via git, so it must stay a warn
    // even though the branch has not diverged from the default branch.
    fs.writeFileSync(path.join(cloneDir, ".env"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(cloneDir);

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });
});

describe("runSecretDetection — git-enumerated file set", () => {
  const secretLine = `const secret = "${REAL_SECRET}";\n`;

  function git(dir: string, ...args: string[]): void {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  }

  function gitCommitAll(dir: string): void {
    git(dir, "add", "-A");
    git(
      dir,
      "-c", "user.name=t", "-c", "user.email=t@example.com",
      "commit", "-q", "-m", "init",
    );
  }

  async function withFailingTargetIgnore<T>(fn: () => Promise<T>): Promise<T> {
    const bin = makeTempDir("preflight-secrets-git-query-shim-");
    const realGit = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "git")).find((file) => fs.existsSync(file));
    expect(realGit).toBeDefined();
    // Inject one command failure; every other call, including per-file
    // ignore classification, runs the real git binary against the fixture.
    const shim = path.join(bin, "git");
    fs.writeFileSync(shim, [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args.join(' ') === 'check-ignore -q -- .') process.exit(128);",
      `const child = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
      "process.exit(child.status ?? 128);",
      "",
    ].join("\n"));
    fs.chmodSync(shim, 0o755);
    return withEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, fn);
  }

  it("never reads files inside a large gitignored directory outside SKIP_DIRS", async () => {
    const repoPath = makeTempDir("preflight-secrets-big-ignored-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "web/core/\nweb/libraries/\n");
    fs.writeFileSync(path.join(repoPath, "app.js"), "export const x = 1;\n");
    for (const dir of ["web/core/lib", "web/libraries/foo"]) {
      fs.mkdirSync(path.join(repoPath, dir), { recursive: true });
      for (let i = 0; i < 150; i++) {
        fs.writeFileSync(path.join(repoPath, dir, `f${i}.js`), secretLine);
      }
    }

    const readSpy = vi.spyOn(fs, "readFileSync");
    let result;
    try {
      result = await runSecretDetection(repoPath);
      const readPaths = readSpy.mock.calls.map((c) => String(c[0]));
      expect(readPaths.some((p) => p.includes(`${path.sep}web${path.sep}`))).toBe(false);
      expect(readPaths.some((p) => p.endsWith("app.js"))).toBe(true);
    } finally {
      readSpy.mockRestore();
    }

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });

  it("still fails on tracked and on untracked-not-ignored secrets", async () => {
    const repoPath = makeTempDir("preflight-secrets-committable-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "web/core/\n");
    fs.writeFileSync(path.join(repoPath, "tracked.js"), secretLine);
    gitCommitAll(repoPath);
    fs.writeFileSync(path.join(repoPath, "untracked.js"), secretLine);
    fs.mkdirSync(path.join(repoPath, "web", "core"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "web", "core", "ignored.js"), secretLine);

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("fail");
    const details = result.checks[0]?.details ?? [];
    expect(details).toContain("tracked.js:1");
    expect(details).toContain("untracked.js:1");
    expect(details.some((d) => d.includes("ignored.js"))).toBe(false);
  });

  it("scans a force-added tracked file under an ignored path", async () => {
    const repoPath = makeTempDir("preflight-secrets-forced-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "web/core/\n");
    fs.mkdirSync(path.join(repoPath, "web", "core"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "web", "core", "forced.js"), secretLine);
    git(repoPath, "add", "-f", "web/core/forced.js");

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("web/core/forced.js:1");
  });

  it("falls back to the filesystem walk outside a git repository", async () => {
    const dir = makeTempDir("preflight-secrets-nongit-");
    fs.mkdirSync(path.join(dir, "web", "core"), { recursive: true });
    fs.writeFileSync(path.join(dir, "web", "core", "found.js"), secretLine);

    const result = await runSecretDetection(dir);

    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.details).toContain("web/core/found.js:1 (non-blocking)");
    expect(result.limitations.some((l) => l.includes("not a git repository"))).toBe(true);
  });

  it("falls back to the walk when git cannot list files (broken .git), never scanning nothing", async () => {
    const dir = makeTempDir("preflight-secrets-brokengit-");
    fs.mkdirSync(path.join(dir, ".git")); // present but not a valid repository
    fs.writeFileSync(path.join(dir, "leak.js"), secretLine);

    const result = await runSecretDetection(dir);

    expect(result.checks[0]?.status).not.toBe("pass");
    expect(result.checks[0]?.details?.join("\n")).toContain("leak.js:1");
  });

  it("handles paths with spaces, unicode and newlines", async () => {
    const repoPath = makeTempDir("preflight-secrets-odd-names-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "mein Ordner", "Übung"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "mein Ordner", "Übung", "größe ü.js"), secretLine);
    fs.writeFileSync(path.join(repoPath, "line\nbreak.js"), secretLine);

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("fail");
    const details = result.checks[0]?.details ?? [];
    expect(details).toContain("mein Ordner/Übung/größe ü.js:1");
    expect(details).toContain("line\nbreak.js:1");
  });

  it("skips files git lists but that were deleted from the work tree", async () => {
    const repoPath = makeTempDir("preflight-secrets-deleted-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "gone.js"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repoPath, "stay.js"), secretLine);
    gitCommitAll(repoPath);
    fs.rmSync(path.join(repoPath, "gone.js"));

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["stay.js:1"]);
  });

  it("does not follow symlinks, including tracked ones pointing outside the repo", async () => {
    const outside = makeTempDir("preflight-secrets-outside-");
    fs.writeFileSync(path.join(outside, "outside.js"), secretLine);
    fs.mkdirSync(path.join(outside, "dir"));
    fs.writeFileSync(path.join(outside, "dir", "inner.js"), secretLine);
    const repoPath = makeTempDir("preflight-secrets-symlink-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "ok.js"), "export const a = 1;\n");
    fs.symlinkSync(path.join(outside, "outside.js"), path.join(repoPath, "link-file.js"));
    fs.symlinkSync(path.join(outside, "dir"), path.join(repoPath, "link-dir"));
    git(repoPath, "add", "-f", "link-file.js", "link-dir");

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });

  it("scans only the subtree when repoPath is a subdirectory of the git root", async () => {
    const root = makeTempDir("preflight-secrets-subdir-");
    gitInit(root);
    fs.mkdirSync(path.join(root, "pkg", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "pkg", "src", "a.js"), secretLine);
    fs.writeFileSync(path.join(root, "other", "b.js"), secretLine);
    fs.writeFileSync(path.join(root, "top.js"), secretLine);

    const result = await runSecretDetection(path.join(root, "pkg"), { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["src/a.js:1"]);
  });

  it("applies SKIP_DIRS to git-listed paths like the walk does", async () => {
    const repoPath = makeTempDir("preflight-secrets-skipdirs-");
    gitInit(repoPath);
    fs.mkdirSync(path.join(repoPath, "vendor", "lib"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "packages", "x", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "vendor", "lib", "v.js"), secretLine);
    fs.writeFileSync(path.join(repoPath, "packages", "x", "node_modules", "n.js"), secretLine);
    git(repoPath, "add", "-f", ".");

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("pass");
  });

  it("does not scan nested repositories (their files cannot be committed here)", async () => {
    const repoPath = makeTempDir("preflight-secrets-nested-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "top.js"), "export const a = 1;\n");
    const nested = path.join(repoPath, "nested");
    fs.mkdirSync(nested);
    gitInit(nested);
    fs.writeFileSync(path.join(nested, "inner.js"), secretLine);

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });

  it("is not fooled by GIT_DIR and GIT_WORK_TREE pointing at another repository", async () => {
    // Without a guard, `git ls-files` here succeeds against the foreign
    // repository and lists only its files, so the secret file would drop
    // out of the scan. The foreign repository shares one benign file name
    // with the scanned directory so the "no listed entry exists" backstop
    // does not apply. The work-tree containment check and the ignore check
    // each catch this scenario on their own; the GIT_DIR-only test below is
    // the one that pins the environment scrubbing.
    const foreign = makeTempDir("preflight-secrets-foreign-");
    gitInit(foreign);
    fs.writeFileSync(path.join(foreign, "README.md"), "# foreign\n");
    fs.writeFileSync(path.join(foreign, "only-there.txt"), "x\n");
    git(foreign, "add", "-A");
    const repoPath = makeTempDir("preflight-secrets-redirected-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# scanned\n");
    fs.writeFileSync(path.join(repoPath, "leak.js"), secretLine);

    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(foreign, ".git");
    process.env.GIT_WORK_TREE = foreign;
    let result;
    try {
      result = await runSecretDetection(repoPath, { secretDetectionStrict: true });
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    }

    expect(result.checks[0]?.details).toContain("leak.js:1");
  });

  it("keeps working when a hook-style GIT_INDEX_FILE points at a copy of the index", async () => {
    const repoPath = makeTempDir("preflight-secrets-index-file-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "tracked.js"), secretLine);
    git(repoPath, "add", "tracked.js");
    fs.writeFileSync(path.join(repoPath, "new.js"), secretLine);
    const indexCopy = path.join(repoPath, ".git", "index.hook");
    fs.copyFileSync(path.join(repoPath, ".git", "index"), indexCopy);

    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = indexCopy;
    let result;
    try {
      result = await runSecretDetection(repoPath, { secretDetectionStrict: true });
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved;
    }

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(
      expect.arrayContaining(["tracked.js:1", "new.js:1"]),
    );
  });

  it("falls back to the walk when repoPath is itself ignored by a parent repository", async () => {
    const parent = makeTempDir("preflight-secrets-parent-ignore-");
    gitInit(parent);
    fs.writeFileSync(path.join(parent, ".gitignore"), "build/\n");
    const repoPath = path.join(parent, "build", "proj");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "leak.js"), secretLine);

    const result = await runSecretDetection(repoPath);

    // Not a silent pass: the walk reads the directory, and the parent
    // repository classifies the file as gitignored-untracked (warn).
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.details).toContain("leak.js:1 (non-blocking)");
  });

  it("uses the git listing for a non-ignored subdirectory of a repository whose other paths are ignored", async () => {
    const parent = makeTempDir("preflight-secrets-parent-partial-");
    gitInit(parent);
    fs.writeFileSync(path.join(parent, ".gitignore"), "build/\n");
    fs.mkdirSync(path.join(parent, "pkg"));
    fs.writeFileSync(path.join(parent, "pkg", "leak.js"), secretLine);

    const result = await runSecretDetection(path.join(parent, "pkg"), { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["leak.js:1"]);
  });

  it("falls back to the walk when every git-listed entry is missing from disk", async () => {
    const repoPath = makeTempDir("preflight-secrets-all-missing-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "gone.js"), "export const a = 1;\n");
    gitCommitAll(repoPath);
    fs.rmSync(path.join(repoPath, "gone.js"));
    // Excluded via .git/info/exclude so the only listed entry (the
    // tracked, now deleted gone.js) is missing from disk.
    fs.writeFileSync(path.join(repoPath, ".git", "info", "exclude"), ".env\n");
    fs.writeFileSync(path.join(repoPath, ".env"), `API_KEY="${REAL_SECRET}"\n`);

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    // Listing = {gone.js}, not on disk: the listing is not trusted, so the
    // walk runs and finds the file. Never "scanned nothing".
    expect(result.checks[0]?.details?.join("\n")).toContain(".env:1");
  });

  it("scans a repository with a real submodule: parent secret blocks, submodule files are not scanned", async () => {
    const subSource = makeTempDir("preflight-secrets-submodule-src-");
    gitInit(subSource);
    fs.writeFileSync(path.join(subSource, "inner.js"), secretLine);
    git(subSource, "add", "-A");
    git(subSource, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "sub");
    const repoPath = makeTempDir("preflight-secrets-submodule-parent-");
    gitInit(repoPath);
    git(repoPath, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSource, "sub");
    expect(fs.existsSync(path.join(repoPath, "sub", "inner.js"))).toBe(true);
    fs.writeFileSync(path.join(repoPath, "parent.js"), secretLine);

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    // The walk used to descend into the submodule, where `git check-ignore`
    // exits 128 and masked every finding as a non-blocking warning.
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["parent.js:1"]);
  });

  /** Run `fn` with the given environment variables set, restoring them afterwards. */
  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  it("still reports a force-added tracked secret when GIT_DIR alone points at another repository", async () => {
    // Containment and ignore checks pass here (the work tree is the scanned
    // directory), so only scrubbing GIT_DIR keeps the real index in use: in
    // the foreign index .env is untracked and, via the scanned directory's
    // .gitignore, ignored, so it would be neither listed nor blocking.
    const foreign = makeTempDir("preflight-secrets-foreign-gitdir-");
    gitInit(foreign);
    const repoPath = makeTempDir("preflight-secrets-gitdir-only-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(repoPath, ".env"), `API_KEY="${REAL_SECRET}"\n`);
    git(repoPath, "add", "-f", ".env");

    const result = await withEnv({ GIT_DIR: path.join(foreign, ".git") }, () =>
      runSecretDetection(repoPath),
    );

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain(".env:1");
  });

  it("keeps a new untracked secret blocking when GIT_DIR and GIT_WORK_TREE point at a foreign repository with a resolvable diff base", async () => {
    const remote = makeTempDir("preflight-secrets-foreign-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const foreign = makeTempDir("preflight-secrets-foreign-upstream-");
    gitInit(foreign);
    fs.writeFileSync(path.join(foreign, "README.md"), "# foreign\n");
    gitCommitAll(foreign);
    git(foreign, "remote", "add", "origin", remote);
    git(foreign, "push", "-q", "origin", "main");
    git(foreign, "branch", "-q", "-u", "origin/main");
    const repoPath = makeTempDir("preflight-secrets-foreign-diffbase-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# scanned\n");
    fs.writeFileSync(path.join(repoPath, "new.js"), secretLine);

    // Default (diff-scoped) tiering: the foreign repository's diff base and
    // changed-file set must not be used to classify the scanned directory.
    const result = await withEnv(
      { GIT_DIR: path.join(foreign, ".git"), GIT_WORK_TREE: foreign },
      () => runSecretDetection(repoPath),
    );

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain("new.js:1");
  });

  it("uses the git listing for a non-ignored subdirectory and never reads ignored files below it", async () => {
    const root = makeTempDir("preflight-secrets-subdir-ignored-below-");
    gitInit(root);
    fs.writeFileSync(path.join(root, ".gitignore"), "pkg/build/\n");
    fs.mkdirSync(path.join(root, "pkg", "build"), { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", "build", "b.js"), secretLine);
    fs.writeFileSync(path.join(root, "pkg", "ok.js"), "export const a = 1;\n");

    const readSpy = vi.spyOn(fs, "readFileSync");
    let result;
    try {
      result = await runSecretDetection(path.join(root, "pkg"));
      const readPaths = readSpy.mock.calls.map((c) => String(c[0]));
      expect(readPaths.some((p) => p.endsWith("b.js"))).toBe(false);
      expect(readPaths.some((p) => p.endsWith("ok.js"))).toBe(true);
    } finally {
      readSpy.mockRestore();
    }

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.details).toEqual([]);
  });

  /** A bare repository whose work tree is a separate directory (dotfile-manager style). */
  function makeBarePlusWorktree(): { bare: string; work: string } {
    const bare = makeTempDir("preflight-secrets-bare-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
    const work = makeTempDir("preflight-secrets-bare-work-");
    fs.writeFileSync(path.join(work, ".gitignore"), "ign/\n");
    fs.mkdirSync(path.join(work, "ign"));
    fs.writeFileSync(path.join(work, "ign", "i.js"), secretLine);
    fs.writeFileSync(path.join(work, "leak.js"), secretLine);
    execFileSync(
      "git",
      ["--git-dir", bare, "--work-tree", work, "add", ".gitignore", "leak.js"],
      { cwd: work, stdio: "ignore" },
    );
    return { bare, work };
  }

  it("keeps GIT_DIR and GIT_WORK_TREE of a bare repository with a separate work tree", async () => {
    const { bare, work } = makeBarePlusWorktree();

    const result = await withEnv({ GIT_DIR: bare, GIT_WORK_TREE: work }, () =>
      runSecretDetection(work),
    );

    // The staged secret is committable and blocks; the ignored file is not
    // read, which also shows the git listing (not the walk) was used.
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["leak.js:1"]);
  });

  it("works with the environment git exports to a pre-commit hook of such a repository", async () => {
    const { bare, work } = makeBarePlusWorktree();

    // As exported to a hook by `git --git-dir=... --work-tree=... commit`.
    const result = await withEnv(
      { GIT_DIR: bare, GIT_WORK_TREE: work, GIT_INDEX_FILE: path.join(bare, "index"), GIT_PREFIX: "" },
      () => runSecretDetection(work),
    );

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["leak.js:1"]);
  });

  it("uses the git listing for a repository with a separate git directory (.git file)", async () => {
    const gitDir = path.join(makeTempDir("preflight-secrets-sepgit-dir-"), "repo.git");
    const repoPath = makeTempDir("preflight-secrets-sepgit-");
    execFileSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", gitDir], {
      cwd: repoPath,
      stdio: "ignore",
    });
    expect(fs.statSync(path.join(repoPath, ".git")).isFile()).toBe(true);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "ign/\n");
    fs.mkdirSync(path.join(repoPath, "ign"));
    fs.writeFileSync(path.join(repoPath, "ign", "i.js"), secretLine);
    fs.writeFileSync(path.join(repoPath, "leak.js"), secretLine);

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["leak.js:1"]);
  });

  it("uses the git listing in a linked worktree whose GIT_DIR points at its own git directory", async () => {
    const main = makeTempDir("preflight-secrets-linked-main-");
    gitInit(main);
    fs.writeFileSync(path.join(main, ".gitignore"), "ign/\n");
    fs.writeFileSync(path.join(main, "a.js"), "export const a = 1;\n");
    gitCommitAll(main);
    const linked = path.join(makeTempDir("preflight-secrets-linked-parent-"), "wt");
    git(main, "worktree", "add", "-q", "-b", "wt", linked);
    fs.mkdirSync(path.join(linked, "ign"));
    fs.writeFileSync(path.join(linked, "ign", "i.js"), secretLine);
    fs.writeFileSync(path.join(linked, "leak.js"), secretLine);
    const linkedGitDir = path.join(main, ".git", "worktrees", "wt");
    expect(fs.existsSync(linkedGitDir)).toBe(true);

    const result = await withEnv(
      { GIT_DIR: linkedGitDir, GIT_INDEX_FILE: path.join(linkedGitDir, "index") },
      () => runSecretDetection(linked),
    );

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["leak.js:1"]);
  });

  it("does not apply another repository's linked-worktree hook environment to the scanned repository", async () => {
    // Hook environment of repository A's linked worktree (GIT_DIR,
    // GIT_INDEX_FILE, GIT_PREFIX) while scanning repository B, whose
    // .env is force-added although ignored. Only discarding the foreign
    // GIT_INDEX_FILE makes B's own index the one that is listed.
    const a = makeTempDir("preflight-secrets-hookenv-a-");
    gitInit(a);
    fs.writeFileSync(path.join(a, "x.txt"), "x\n");
    gitCommitAll(a);
    const aLinked = path.join(makeTempDir("preflight-secrets-hookenv-awt-"), "wt");
    git(a, "worktree", "add", "-q", "-b", "wt", aLinked);
    const aGitDir = path.join(a, ".git", "worktrees", "wt");
    const b = makeTempDir("preflight-secrets-hookenv-b-");
    gitInit(b);
    fs.writeFileSync(path.join(b, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(b, ".env"), `API_KEY="${REAL_SECRET}"\n`);
    git(b, "add", "-f", ".env", ".gitignore");

    const result = await withEnv(
      { GIT_DIR: aGitDir, GIT_INDEX_FILE: path.join(aGitDir, "index"), GIT_PREFIX: "" },
      () => runSecretDetection(b, { secretDetectionStrict: true }),
    );

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain(".env:1");
  });

  it.each(["index only", "index and prefix", "symlink inside git dir", "sibling git-dir prefix"])(
    "drops a foreign hook index while scanning another repository: %s",
    async (shape) => {
      const a = makeTempDir("preflight-secrets-index-owner-");
      gitInit(a);
      fs.writeFileSync(path.join(a, "common.txt"), "benign\n");
      git(a, "add", "common.txt");
      const b = makeTempDir("preflight-secrets-index-target-");
      gitInit(b);
      fs.writeFileSync(path.join(b, "common.txt"), "benign\n");
      fs.writeFileSync(path.join(b, ".gitignore"), ".env\n");
      fs.writeFileSync(path.join(b, ".env"), `API_KEY="${REAL_SECRET}"\n`);
      git(b, "add", "-f", ".env", ".gitignore", "common.txt");
      let index = path.join(a, ".git", "index");
      if (shape === "symlink inside git dir") {
        const link = path.join(b, ".git", "index.hook");
        fs.symlinkSync(index, link);
        index = link;
      } else if (shape === "sibling git-dir prefix") {
        const sibling = path.join(b, ".git-foreign");
        fs.mkdirSync(sibling);
        fs.copyFileSync(index, path.join(sibling, "index"));
        index = path.join(sibling, "index");
      }
      const result = await withEnv(
        { GIT_INDEX_FILE: index, GIT_PREFIX: shape === "index and prefix" ? "" : undefined },
        () => runSecretDetection(b, { secretDetectionStrict: true }),
      );
      expect(result.checks[0]?.status).toBe("fail");
      expect(result.checks[0]?.details).toEqual([".env:1"]);
    },
  );

  it("keeps an owned partial-commit index, including a relative path and an internal symlink", async () => {
    const repoPath = makeTempDir("preflight-secrets-partial-index-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "*.env\n");
    for (const name of ["included.env", "excluded.env"]) fs.writeFileSync(path.join(repoPath, name), secretLine);
    git(repoPath, "add", "-f", "included.env", "excluded.env", ".gitignore");
    const hookIndex = path.join(repoPath, ".git", "index.hook");
    fs.copyFileSync(path.join(repoPath, ".git", "index"), hookIndex);
    await withEnv({ GIT_INDEX_FILE: hookIndex }, async () => { git(repoPath, "update-index", "--force-remove", "excluded.env"); });
    const link = path.join(repoPath, ".git", "index.link");
    fs.symlinkSync(hookIndex, link);
    for (const index of [".git/index.hook", link]) {
      const result = await withEnv({ GIT_INDEX_FILE: index }, () => runSecretDetection(repoPath, { secretDetectionStrict: true }));
      expect(result.checks[0]?.status).toBe("fail");
      // Using the ordinary index instead would incorrectly scan excluded.env.
      expect(result.checks[0]?.details).toEqual(["included.env:1"]);
    }
  });

  it("still blocks a committable secret when GIT_WORK_TREE alone points at an unrelated directory", async () => {
    const repoPath = makeTempDir("preflight-secrets-worktree-only-");
    gitInit(repoPath);
    fs.writeFileSync(path.join(repoPath, "n.js"), secretLine);
    const elsewhere = makeTempDir("preflight-secrets-worktree-elsewhere-");

    const result = await withEnv({ GIT_WORK_TREE: elsewhere }, () =>
      runSecretDetection(repoPath, { secretDetectionStrict: true }),
    );

    // Trusting that redirected (empty) work tree would list nothing and
    // report a clean pass.
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toEqual(["n.js:1"]);
  });

  it("reports a secret in a merge-conflicted file exactly once", async () => {
    const repoPath = makeTempDir("preflight-secrets-conflict-");
    gitInit(repoPath);
    const file = path.join(repoPath, "conflicted.js");
    const body = (first: string, last: string) =>
      `${first}\nline2\nline3\n${secretLine}line5\nline6\n${last}\n`;
    fs.writeFileSync(file, body("base-first", "base-last"));
    gitCommitAll(repoPath);
    git(repoPath, "checkout", "-q", "-b", "other");
    fs.writeFileSync(file, body("theirs-first", "theirs-last"));
    git(repoPath, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "theirs");
    git(repoPath, "checkout", "-q", "main");
    fs.writeFileSync(file, body("ours-first", "ours-last"));
    git(repoPath, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "ours");
    // The merge must stop with a conflict (git exits non-zero), so the
    // index then holds three stages of conflicted.js.
    expect(() =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "merge", "other"], { cwd: repoPath, stdio: "ignore" }),
    ).toThrow();
    const listed = execFileSync("git", ["ls-files"], { cwd: repoPath, encoding: "utf8" })
      .split("\n")
      .filter((l) => l === "conflicted.js");
    expect(listed.length).toBe(3);

    const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details?.filter((d) => d.startsWith("conflicted.js:"))).toHaveLength(1);
  });

  describe("paths git lists but the scan must not trust", () => {
    /** A tracked config/settings.js whose directory is then replaced by a symlink to `target`. */
    function repoWithSymlinkedDir(target: (repoPath: string) => string): string {
      const repoPath = makeTempDir("preflight-secrets-symdir-");
      gitInit(repoPath);
      fs.mkdirSync(path.join(repoPath, "config"));
      fs.writeFileSync(path.join(repoPath, "config", "settings.js"), "module.exports = {};\n");
      gitCommitAll(repoPath);
      const real = target(repoPath);
      fs.rmSync(path.join(repoPath, "config"), { recursive: true });
      fs.symlinkSync(real, path.join(repoPath, "config"), "dir");
      fs.writeFileSync(path.join(repoPath, "new-leak.js"), secretLine);
      return repoPath;
    }

    async function scanWithReadSpy(repoPath: string) {
      const readSpy = vi.spyOn(fs, "readFileSync");
      try {
        const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });
        return { result, readPaths: readSpy.mock.calls.map((c) => String(c[0])) };
      } finally {
        readSpy.mockRestore();
      }
    }

    it("does not read a tracked file through a directory replaced by a symlink to a tree outside the repository, and a new secret still blocks", async () => {
      const outside = makeTempDir("preflight-secrets-symdir-outside-");
      fs.writeFileSync(path.join(outside, "settings.js"), secretLine);

      const repoPath = repoWithSymlinkedDir(() => outside);
      const { result, readPaths } = await scanWithReadSpy(repoPath);

      expect(readPaths.some((p) => p.includes(outside) || p.includes(`${path.sep}config${path.sep}`))).toBe(false);
      expect(result.checks[0]?.status).toBe("fail");
      expect(result.checks[0]?.details).toEqual(["new-leak.js:1"]);
    });

    it("does not read a tracked file through a directory replaced by a symlink to a tree inside the repository", async () => {
      const repoPath = repoWithSymlinkedDir((r) => {
        const real = path.join(r, "real-config");
        fs.mkdirSync(real);
        fs.writeFileSync(path.join(real, "settings.js"), secretLine);
        fs.writeFileSync(path.join(r, ".gitignore"), "real-config/\n");
        return real;
      });
      const { result, readPaths } = await scanWithReadSpy(repoPath);

      expect(readPaths.some((p) => p.includes(`${path.sep}config${path.sep}`))).toBe(false);
      expect(readPaths.some((p) => p.includes(`${path.sep}real-config${path.sep}`))).toBe(false);
      expect(result.checks[0]?.status).toBe("fail");
      expect(result.checks[0]?.details).toEqual(["new-leak.js:1"]);
    });

    it("does not read a file below a nested symlinked directory either", async () => {
      const outside = makeTempDir("preflight-secrets-symdir-nested-outside-");
      fs.mkdirSync(path.join(outside, "deep"));
      fs.writeFileSync(path.join(outside, "deep", "s.js"), secretLine);
      const repoPath = makeTempDir("preflight-secrets-symdir-nested-");
      gitInit(repoPath);
      fs.mkdirSync(path.join(repoPath, "a", "b"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, "a", "b", "s.js"), "module.exports = {};\n");
      gitCommitAll(repoPath);
      fs.rmSync(path.join(repoPath, "a", "b"), { recursive: true });
      fs.symlinkSync(path.join(outside, "deep"), path.join(repoPath, "a", "b"), "dir");

      const { result, readPaths } = await scanWithReadSpy(repoPath);

      expect(readPaths.some((p) => p.includes(outside))).toBe(false);
      expect(result.checks[0]?.status).toBe("pass");
    });

    it("does not read a tracked file through a symlinked grandparent directory", async () => {
      const outside = makeTempDir("preflight-secrets-symdir-grand-outside-");
      fs.mkdirSync(path.join(outside, "b"));
      fs.writeFileSync(path.join(outside, "b", "c.js"), secretLine);
      const repoPath = makeTempDir("preflight-secrets-symdir-grand-");
      gitInit(repoPath);
      fs.mkdirSync(path.join(repoPath, "a", "b"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, "a", "b", "c.js"), "module.exports = {};\n");
      gitCommitAll(repoPath);
      fs.rmSync(path.join(repoPath, "a"), { recursive: true });
      fs.symlinkSync(outside, path.join(repoPath, "a"), "dir");

      const { result, readPaths } = await scanWithReadSpy(repoPath);

      expect(readPaths.some((p) => p.includes(outside) || p.includes(`${path.sep}a${path.sep}b${path.sep}`))).toBe(false);
      expect(result.checks[0]?.status).toBe("pass");
    });

    it("does not read any of several tracked files under one directory replaced by a symlink", async () => {
      const outside = makeTempDir("preflight-secrets-symdir-multi-outside-");
      fs.writeFileSync(path.join(outside, "a.js"), secretLine);
      fs.writeFileSync(path.join(outside, "b.js"), secretLine);
      const repoPath = makeTempDir("preflight-secrets-symdir-multi-");
      gitInit(repoPath);
      fs.mkdirSync(path.join(repoPath, "c"));
      fs.writeFileSync(path.join(repoPath, "c", "a.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(repoPath, "c", "b.js"), "module.exports = {};\n");
      gitCommitAll(repoPath);
      fs.rmSync(path.join(repoPath, "c"), { recursive: true });
      fs.symlinkSync(outside, path.join(repoPath, "c"), "dir");

      const { result, readPaths } = await scanWithReadSpy(repoPath);

      expect(readPaths.some((p) => p.includes(outside) || p.includes(`${path.sep}c${path.sep}`))).toBe(false);
      expect(result.checks[0]?.status).toBe("pass");
    });

    it("keeps a bare repository target non-blocking as not a work tree", async () => {
      const repoPath = makeTempDir("preflight-secrets-bare-");
      execFileSync("git", ["init", "-q", "--bare", repoPath]);
      fs.writeFileSync(path.join(repoPath, "description"), secretLine);

      const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

      expect(result.checks[0]?.status).toBe("warn");
      expect(result.limitations.some((l) => l.includes("not a git repository"))).toBe(true);
      expect(result.limitations.some((l) => l.includes("could not classify"))).toBe(false);
    });

    // Each name is spelled out here rather than imported, so removing one from
    // the scrubbed list in the source fails its own case. Each case sets
    // exactly one switch; git's check-ignore rejects every call under any of them.
    it.each([
      "GIT_LITERAL_PATHSPECS",
      "GIT_GLOB_PATHSPECS",
      "GIT_NOGLOB_PATHSPECS",
      "GIT_ICASE_PATHSPECS",
    ])("ignores an inherited pathspec mode switch %s: an ignored tree below a subdirectory target is neither read nor blocking", async (name) => {
      const repoPath = makeTempDir("preflight-secrets-pathspec-env-");
      gitInit(repoPath);
      fs.mkdirSync(path.join(repoPath, "sub", "ignored"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, ".gitignore"), "sub/ignored/\n");
      fs.writeFileSync(path.join(repoPath, "sub", "ok.js"), "module.exports = {};\n");
      gitCommitAll(repoPath);
      fs.writeFileSync(path.join(repoPath, "sub", "ignored", "s.js"), secretLine);

      const saved = process.env[name];
      process.env[name] = "1";
      try {
        const { result, readPaths } = await scanWithReadSpy(path.join(repoPath, "sub"));
        expect(readPaths.some((p) => p.includes(`${path.sep}ignored${path.sep}`))).toBe(false);
        expect(result.checks[0]?.status).toBe("pass");
      } finally {
        if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
      }
    });

    it("keeps a new secret blocking when a file is named like pathspec magic", async () => {
      const repoPath = makeTempDir("preflight-secrets-magic-name-");
      gitInit(repoPath);
      fs.writeFileSync(path.join(repoPath, ":(exclude)x.js"), secretLine);
      fs.writeFileSync(path.join(repoPath, "new-leak.js"), secretLine);

      const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

      expect(result.checks[0]?.status).toBe("fail");
      expect(result.checks[0]?.details).toEqual(
        expect.arrayContaining([":(exclude)x.js:1", "new-leak.js:1"]),
      );
      expect(result.checks[0]?.details?.some((d) => d.includes("non-blocking"))).toBe(false);
    });

    it("classifies a file named like pathspec magic as itself (ignored by a parent repository: non-blocking)", async () => {
      const parent = makeTempDir("preflight-secrets-magic-parent-");
      gitInit(parent);
      fs.writeFileSync(path.join(parent, ".gitignore"), "build/\n");
      const repoPath = path.join(parent, "build", "proj");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, ":(exclude)x.js"), secretLine);

      const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

      // Walk fallback (the parent ignores repoPath). The name is looked up
      // as a file name, so the parent's ignore rule applies and it warns.
      expect(result.checks[0]?.status).toBe("warn");
      expect(result.checks[0]?.details).toEqual([":(exclude)x.js:1 (non-blocking)"]);
      expect(result.limitations.some((l) => l.includes("could not classify"))).toBe(false);
    });

    it("keeps findings blocking when git cannot classify them inside a work tree", async () => {
      const repoPath = makeTempDir("preflight-secrets-corrupt-index-");
      gitInit(repoPath);
      fs.writeFileSync(path.join(repoPath, "new-leak.js"), secretLine);
      // A corrupt index makes `git ls-files` and `git check-ignore` fail
      // while the directory is still plainly a git work tree.
      fs.writeFileSync(path.join(repoPath, ".git", "index"), "this is not an index\n");

      const result = await runSecretDetection(repoPath, { secretDetectionStrict: true });

      expect(result.checks[0]?.status).toBe("fail");
      expect(result.checks[0]?.details).toEqual(["new-leak.js:1"]);
      expect(result.limitations.some((l) => l.includes("not a git repository"))).toBe(false);
      expect(result.limitations.some((l) => l.includes("could not classify 1 path(s)"))).toBe(true);
    });

    it("retries a poisoned walk-fallback batch and keeps its ignored path non-blocking", async () => {
      const parent = makeTempDir("preflight-secrets-retry-parent-");
      gitInit(parent);
      fs.writeFileSync(path.join(parent, ".gitignore"), "build/\n");
      gitCommitAll(parent);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf8" }).trim();
      const repoPath = path.join(parent, "build", "proj");
      fs.mkdirSync(path.join(repoPath, "module"), { recursive: true });
      // A gitlink makes check-ignore reject paths inside it. A failed
      // target-directory query forces a walk, so both paths reach the batch.
      git(parent, "update-index", "--add", "--cacheinfo", `160000,${head},build/proj/module`);
      fs.writeFileSync(path.join(repoPath, "module", "poison.js"), secretLine);
      fs.writeFileSync(path.join(repoPath, "ignored.js"), secretLine);

      const result = await withFailingTargetIgnore(() =>
        runSecretDetection(repoPath, { secretDetectionStrict: true }),
      );

      expect(result.checks[0]?.status).toBe("fail");
      expect(result.checks[0]?.details).toEqual([
        "module/poison.js:1", "ignored.js:1 (non-blocking)",
      ]);
      expect(result.limitations.some((l) => l.includes("could not classify 1 path(s)"))).toBe(true);
      expect(result.limitations.some((l) => l.includes("not a git repository"))).toBe(false);
    });

    it("walks an ignored subtree when the target-directory ignore query returns a git error", async () => {
      const repoPath = makeTempDir("preflight-secrets-query-error-");
      gitInit(repoPath);
      fs.mkdirSync(path.join(repoPath, "sub", "ignored"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, ".gitignore"), "sub/ignored/\n");
      fs.writeFileSync(path.join(repoPath, "sub", "ok.js"), "module.exports = {};\n");
      gitCommitAll(repoPath);
      fs.writeFileSync(path.join(repoPath, "sub", "ignored", "found.js"), secretLine);
      const result = await withFailingTargetIgnore(() =>
        runSecretDetection(path.join(repoPath, "sub"), { secretDetectionStrict: true }),
      );
      expect(result.checks[0]?.status).toBe("warn");
      expect(result.checks[0]?.details).toEqual(["ignored/found.js:1 (non-blocking)"]);
      expect(result.limitations.some((l) => l.includes("not a git repository"))).toBe(false);
    });
  });
});
