import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";

describe("create-release-bundle.sh", () => {
  it("creates a release archive with installable contents", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-release-"));
    const outputDir = path.join(tmpRoot, "out");
    const repoRoot = path.resolve(__dirname, "..");

    try {
      execFileSync("bash", ["./scripts/create-release-bundle.sh"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          RELEASE_OUTPUT_DIR: outputDir,
        },
        stdio: "pipe",
      });

      const archiveNames = fs.readdirSync(outputDir).filter((name) => name.endsWith(".tar.gz"));
      expect(archiveNames).toHaveLength(1);

      const archivePath = path.join(outputDir, archiveNames[0]);
      expect(fs.existsSync(`${archivePath}.sha256`)).toBe(true);

      const tarListing = execFileSync("tar", ["-tf", archivePath], {
        encoding: "utf-8",
      });

      expect(tarListing).toContain("install.sh");
      expect(tarListing).toContain("release-manifest.json");
      expect(tarListing).toContain("dist/cli.js");
      expect(tarListing).toContain("dist/mcp.js");
      expect(tarListing).toContain("src/cli.ts");
      expect(tarListing).toContain("Dockerfile");

      // Pin the bundled package.json's `bin` map (not the repo root's — the
      // bundle is what install.sh and npm actually install from), so a
      // package.json edit that drops either binary breaks this test instead
      // of silently shipping a bundle/npm package missing preflight-mcp.
      const bundleDirName = archiveNames[0].replace(/\.tar\.gz$/, "");
      const packageJsonRaw = execFileSync(
        "tar",
        ["-xOf", archivePath, `${bundleDirName}/package.json`],
        { encoding: "utf-8" }
      );
      const pkg = JSON.parse(packageJsonRaw) as { bin?: Record<string, string> };
      expect(pkg.bin?.preflight).toBe("dist/cli.js");
      expect(pkg.bin?.["preflight-mcp"]).toBe("dist/mcp.js");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
