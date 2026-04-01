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
});
