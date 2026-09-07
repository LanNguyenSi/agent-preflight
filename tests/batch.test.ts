import { afterEach, describe, it, expect, vi } from "vitest";
import { discoverRepos, runBatch } from "../src/batch.js";
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

  it("treats regex metacharacters literally in glob patterns", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
    makeTempRepo(tmp, "repo[1]");
    makeTempRepo(tmp, "repo1");

    const repos = discoverRepos(tmp, { only: "repo[1]" });
    expect(repos).toHaveLength(1);
    expect(path.basename(repos[0])).toBe("repo[1]");
    fs.rmSync(tmp, { recursive: true });
  });
});

describe("runBatch", () => {
  it("merges nested check overrides without re-enabling repo config", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-run-test-"));
    const repoPath = makeTempRepo(tmp, "sample-repo");
    const binDir = path.join(tmp, ".bin");
    fs.mkdirSync(binDir, { recursive: true });

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;

    fs.writeFileSync(
      path.join(repoPath, ".preflight.json"),
      JSON.stringify({
        checks: {
          audit: false,
          lint: false,
          typecheck: false,
          test: false,
          commitConvention: false,
          ciSimulation: false,
        },
      })
    );
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({
        name: "sample-repo",
        version: "1.0.0",
      })
    );
    fs.writeFileSync(
      path.join(binDir, "npm"),
      "#!/usr/bin/env bash\nexit 99\n",
      { mode: 0o755 }
    );

    try {
      const result = await runBatch(tmp, {}, { checks: { secretDetection: false } });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].result?.checks.some((check) => check.name === "npm-audit")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runBatch warning count with an invalid PREFLIGHT_LOG_DIR (missing test 2, task 2e8bcc7e review round 2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints exactly one PREFLIGHT_LOG_DIR warning per discovered repo, not one per run and not one per failing check", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-warn-count-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "batch-warn-count-home-"));
    makeTempRepo(tmp, "repo-a");
    makeTempRepo(tmp, "repo-b");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("PREFLIGHT_LOG_DIR", "relative/not/absolute");
    try {
      const configOverride = {
        checks: {
          gitState: false,
          lint: false,
          typecheck: false,
          test: false,
          audit: false,
          ciSimulation: false,
          commitConvention: false,
          secretDetection: false,
        },
        customChecks: [{ name: "always-fail", command: "echo boom && exit 1" }],
      };

      const result = await runBatch(tmp, {}, configOverride);

      expect(result.results).toHaveLength(2);
      for (const entry of result.results) {
        expect(entry.result?.checks.find((c) => c.name === "always-fail")?.status).toBe("fail");
      }

      const warningCalls = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("PREFLIGHT_LOG_DIR")
      );
      // repoA and repoB each ran a separate runPreflight() call (src/batch.ts's
      // sequential for-loop), so each resolves PREFLIGHT_LOG_DIR once, for a
      // total of two: this pins the "once per repository run" wording (review
      // finding F1, task 2e8bcc7e), not "once per preflight run/batch
      // invocation" as an earlier CHANGELOG draft said.
      expect(warningCalls).toHaveLength(2);
    } finally {
      homedirSpy.mockRestore();
      warnSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
