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
