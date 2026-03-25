import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";

describe("install.sh", () => {
  it("installs launchers into a custom target directory", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-install-"));
    const homeDir = path.join(tmpRoot, "home");
    const installDir = path.join(tmpRoot, "install");
    const binDir = path.join(tmpRoot, "bin");
    fs.mkdirSync(homeDir, { recursive: true });

    try {
      execFileSync("bash", ["./install.sh"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          HOME: homeDir,
          SHELL: "/bin/bash",
          PREFLIGHT_INSTALL_DIR: installDir,
          PREFLIGHT_BIN_DIR: binDir,
        },
        stdio: "pipe",
      });

      const preflightPath = path.join(binDir, "preflight");
      const sandboxPath = path.join(binDir, "preflight-sandbox");

      expect(fs.existsSync(preflightPath)).toBe(true);
      expect(fs.existsSync(sandboxPath)).toBe(true);
      expect(fs.existsSync(path.join(installDir, "dist", "cli.js"))).toBe(true);
      expect(fs.existsSync(path.join(installDir, "src", "cli.ts"))).toBe(true);
      expect(fs.existsSync(path.join(installDir, "Dockerfile"))).toBe(true);
      expect(fs.existsSync(path.join(installDir, "tsconfig.json"))).toBe(true);
      expect(fs.existsSync(path.join(installDir, "vitest.config.ts"))).toBe(true);

      const helpOutput = execFileSync(preflightPath, ["--help"], {
        env: { ...process.env, HOME: homeDir },
        encoding: "utf-8",
      });
      expect(helpOutput).toContain("preflight");
      expect(helpOutput).toContain("sandbox");

      const printOutput = execFileSync(preflightPath, ["sandbox", "--print"], {
        env: { ...process.env, HOME: homeDir },
        encoding: "utf-8",
      });
      expect(printOutput).toContain("docker run");

      const aliasOutput = execFileSync(sandboxPath, ["--print"], {
        env: { ...process.env, HOME: homeDir },
        encoding: "utf-8",
      });
      expect(aliasOutput).toContain("docker run");

      const shellRc = path.join(homeDir, ".profile");
      expect(fs.existsSync(shellRc)).toBe(true);
      expect(fs.readFileSync(shellRc, "utf-8")).toContain(`export PATH="${binDir}:$PATH"`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("installs from a release bundle directory", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-bundle-install-"));
    const bundleDir = path.join(tmpRoot, "bundle");
    const homeDir = path.join(tmpRoot, "home");
    const installDir = path.join(tmpRoot, "install");
    const binDir = path.join(tmpRoot, "bin");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const repoRoot = path.resolve(__dirname, "..");
    const copyDir = (name: string) => fs.cpSync(path.join(repoRoot, name), path.join(bundleDir, name), { recursive: true });
    const copyFile = (name: string) => fs.copyFileSync(path.join(repoRoot, name), path.join(bundleDir, name));

    copyDir("dist");
    copyDir("node_modules");
    copyDir("src");
    copyFile("install.sh");
    copyFile("agent-preflight-sandbox");
    copyFile("package.json");
    copyFile("package-lock.json");
    copyFile("tsconfig.json");
    copyFile("vitest.config.ts");
    copyFile("Dockerfile");
    copyFile("README.md");
    fs.writeFileSync(
      path.join(bundleDir, "release-manifest.json"),
      JSON.stringify({ name: "agent-preflight", version: "0.1.0" }, null, 2)
    );

    try {
      execFileSync("bash", ["./install.sh"], {
        cwd: bundleDir,
        env: {
          ...process.env,
          HOME: homeDir,
          SHELL: "/bin/bash",
          PREFLIGHT_INSTALL_DIR: installDir,
          PREFLIGHT_BIN_DIR: binDir,
        },
        stdio: "pipe",
      });

      expect(fs.existsSync(path.join(installDir, "release-manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(installDir, "src", "cli.ts"))).toBe(true);
      expect(fs.existsSync(path.join(binDir, "preflight"))).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
