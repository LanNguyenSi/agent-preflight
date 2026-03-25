import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig } from "../src/config.js";
import { runPreflight } from "../src/runner.js";

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

describe("profile configuration", () => {
  it("merges nested config keys from .preflight.json", () => {
    const repoPath = makeTempDir("preflight-config-");
    fs.writeFileSync(
      path.join(repoPath, ".preflight.json"),
      JSON.stringify({
        workingDir: "apps/api",
        checks: {
          audit: false,
        },
        commands: {
          test: ["true"],
        },
      })
    );

    const config = loadConfig(repoPath);

    expect(config.workingDir).toBe("apps/api");
    expect(config.checks?.audit).toBe(false);
    expect(config.checks?.lint).toBe(true);
    expect(config.commands?.test).toEqual(["true"]);
  });

  it("runs configured test commands", async () => {
    const repoPath = makeTempDir("preflight-test-command-");

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: true,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      commands: {
        test: ["true"],
      },
    });

    expect(result.blockers).toHaveLength(0);
    expect(result.checks.some((check) => check.kind === "test" && check.status === "pass")).toBe(true);
  });

  it("resolves workingDir before running checks", async () => {
    const repoPath = makeTempDir("preflight-working-dir-");
    const workingDir = path.join(repoPath, "apps", "api");
    fs.mkdirSync(workingDir, { recursive: true });

    const result = await runPreflight(repoPath, {
      workingDir: "apps/api",
      checks: {
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      customChecks: [
        {
          name: "cwd-check",
          command: `[ "$(pwd)" = "${workingDir}" ]`,
        },
      ],
    });

    expect(result.blockers).toHaveLength(0);
    expect(result.checks.find((check) => check.name === "cwd-check")?.status).toBe("pass");
  });

  it("downgrades optional custom checks to warnings", async () => {
    const repoPath = makeTempDir("preflight-custom-warn-");

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      customChecks: [
        {
          name: "optional-smoke",
          command: "false",
          failOnError: false,
        },
      ],
    });

    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toContain("optional-smoke failed");
  });
});
