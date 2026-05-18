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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runSecretDetection", () => {
  it("flags secrets in real .env files", async () => {
    const repoPath = makeTempDir("preflight-secrets-env-");
    fs.writeFileSync(path.join(repoPath, ".env"), 'API_KEY="abcdefghijklmnopqrstuvwxyz123456"\n');

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain(".env");
  });

  it("ignores example env templates", async () => {
    const repoPath = makeTempDir("preflight-secrets-example-");
    fs.writeFileSync(path.join(repoPath, ".env.example"), 'API_KEY="abcdefghijklmnopqrstuvwxyz123456"\n');

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
    const fakeSecret = 'secret: "abcdefghijklmnopqrstuvwxyz123456"\n';
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

  it("still flags the same fake secret when it sits in source (not under a build dir)", async () => {
    // Mirror-image control for the build-dir skip: the rule must catch
    // the same string when it lives somewhere the scanner is allowed
    // to walk. Without this, the "pass" above could be hiding a broken
    // detector rather than a working skip-set.
    const repoPath = makeTempDir("preflight-secrets-source-control-");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "src", "leaked.js"),
      'secret: "abcdefghijklmnopqrstuvwxyz123456"\n',
    );

    const result = await runSecretDetection(repoPath);

    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.details).toContain(path.join("src", "leaked.js"));
  });
});
