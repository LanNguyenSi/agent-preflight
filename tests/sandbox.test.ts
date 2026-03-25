import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDockerBuildCommand,
  buildDockerRunCommand,
  buildSandboxImageName,
  buildSandboxPreflightArgs,
  detectSandboxProfile,
  formatCommand,
  sanitizeContainerName,
  shouldAutoBuild,
} from "../src/sandbox.js";

const tempPaths: string[] = [];

describe("sandbox helpers", () => {
  afterEach(() => {
    for (const tempPath of tempPaths.splice(0)) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it("builds preflight args for sandbox runs", () => {
    expect(
      buildSandboxPreflightArgs({
        json: true,
        ciSimulation: true,
        noAudit: true,
        noSecrets: true,
      })
    ).toEqual([
      "run",
      "/workspace",
      "--json",
      "--ci-simulation",
      "--no-audit",
      "--no-secrets",
    ]);
  });

  it("builds docker run commands with cache mounts and docker socket", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-sandbox-"));
    tempPaths.push(tmpRoot);

    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(homeDir, ".npm"), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".m2"), { recursive: true });

    const command = buildDockerRunCommand(
      {
        workspacePath: path.join(tmpRoot, "Space Repo"),
        image: "agent-preflight:local",
        dockerSocket: true,
        tty: false,
        homeDir,
      },
      ["run", "/workspace", "--json"]
    );

    expect(command).toContain("docker");
    expect(command).toContain("run");
    expect(command).toContain("agent-preflight-space-repo");
    expect(command).toContain(`${homeDir}/.npm:/root/.npm`);
    expect(command).toContain(`${homeDir}/.m2:/root/.m2`);
    expect(command).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(command.slice(-3)).toEqual(["run", "/workspace", "--json"]);
  });

  it("sanitizes container names consistently", () => {
    expect(sanitizeContainerName("Space Dir")).toBe("space-dir");
    expect(sanitizeContainerName("___")).toBe("___");
    expect(sanitizeContainerName("%%%")).toBe("workspace");
  });

  it("formats commands for print output", () => {
    expect(formatCommand(["docker", "run", "/tmp/Space Repo"])).toBe("docker run '/tmp/Space Repo'");
  });

  it("auto-builds for a missing resolved image", () => {
    expect(
      shouldAutoBuild({
        buildRequested: false,
        pullRequested: false,
        printOnly: false,
        canAutoBuild: true,
        imageExists: false,
      })
    ).toBe(true);

    expect(
      shouldAutoBuild({
        buildRequested: false,
        pullRequested: false,
        printOnly: true,
        canAutoBuild: true,
        imageExists: false,
      })
    ).toBe(false);

    expect(
      shouldAutoBuild({
        buildRequested: true,
        pullRequested: false,
        printOnly: false,
        canAutoBuild: true,
        imageExists: false,
      })
    ).toBe(false);

    expect(
      shouldAutoBuild({
        buildRequested: false,
        pullRequested: false,
        printOnly: false,
        canAutoBuild: false,
        imageExists: false,
      })
    ).toBe(false);
  });

  it("detects Symfony and PHP extension packages for the sandbox profile", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-symfony-"));
    tempPaths.push(repoPath);
    fs.mkdirSync(path.join(repoPath, "bin"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "bin", "console"), "");
    fs.writeFileSync(
      path.join(repoPath, "composer.json"),
      JSON.stringify({
        require: {
          "symfony/framework-bundle": "^7.0",
          "ext-intl": "*",
          "ext-xml": "*",
        },
      })
    );

    const profile = detectSandboxProfile(
      repoPath,
      {
        sandbox: {
          aptPackages: ["git-lfs"],
          pipPackages: ["bandit"],
        },
      },
      {}
    );

    expect(profile.capabilities).toEqual(["php", "symfony"]);
    expect(profile.aptPackages).toContain("git-lfs");
    expect(profile.aptPackages).toContain("php-intl");
    expect(profile.aptPackages).toContain("php-xml");
    expect(profile.pipPackages).toEqual(["bandit"]);
  });

  it("builds a capability-based image name and build command", () => {
    const profile = {
      capabilities: ["php", "symfony"],
      aptPackages: ["php-intl", "php-xml"],
      pipPackages: [],
      fingerprint: "1234567890abcdef1234567890abcdef",
      targetPath: "/tmp/repo",
    };

    expect(buildSandboxImageName(profile)).toBe("agent-preflight:local-php-symfony-1234567890ab");

    const command = buildDockerBuildCommand("/tmp/preflight", "agent-preflight:local-php-symfony-1234567890ab", profile);
    expect(command).toContain("--build-arg");
    expect(command).toContain("EXTRA_APT_PACKAGES=php-intl php-xml");
    expect(command).toContain("SANDBOX_PROFILE=1234567890abcdef1234567890abcdef");
  });
});
