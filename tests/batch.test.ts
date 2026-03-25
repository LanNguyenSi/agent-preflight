import { describe, it, expect } from "vitest";
import { discoverRepos } from "../src/batch.js";
import fs from "fs";
import path from "path";
import os from "os";

function makeTempRepo(dir: string, name: string): string {
  const repoPath = path.join(dir, name);
  fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
  return repoPath;
}

describe("discoverRepos", () => {
  it("finds git repos in a directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
    makeTempRepo(tmp, "frost-core");
    makeTempRepo(tmp, "frost-dashboard");
    makeTempRepo(tmp, "allergen-guard");
    fs.mkdirSync(path.join(tmp, "not-a-repo")); // no .git

    const repos = discoverRepos(tmp);
    expect(repos).toHaveLength(3);
    fs.rmSync(tmp, { recursive: true });
  });

  it("filters repos by --only pattern", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
    makeTempRepo(tmp, "frost-core");
    makeTempRepo(tmp, "frost-dashboard");
    makeTempRepo(tmp, "allergen-guard");

    const repos = discoverRepos(tmp, { only: "frost-*" });
    expect(repos).toHaveLength(2);
    expect(repos.every((r) => path.basename(r).startsWith("frost-"))).toBe(true);
    fs.rmSync(tmp, { recursive: true });
  });

  it("excludes repos by --exclude pattern", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
    makeTempRepo(tmp, "frost-core");
    makeTempRepo(tmp, "frost-dashboard");
    makeTempRepo(tmp, "allergen-guard");

    const repos = discoverRepos(tmp, { exclude: "frost-*" });
    expect(repos).toHaveLength(1);
    expect(path.basename(repos[0])).toBe("allergen-guard");
    fs.rmSync(tmp, { recursive: true });
  });

  it("ignores hidden directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
    makeTempRepo(tmp, "frost-core");
    makeTempRepo(tmp, ".hidden-repo");

    const repos = discoverRepos(tmp);
    expect(repos).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true });
  });
});
