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
  function makeFreshClone(fileName: string, content: string): string {
    const remoteDir = makeTempDir("preflight-secrets-remote-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "master"], {
      cwd: remoteDir,
      stdio: "ignore",
    });

    const seedDir = makeTempDir("preflight-secrets-seed-");
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: seedDir, stdio: "ignore" });
    fs.writeFileSync(path.join(seedDir, fileName), content);
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
  });
});
