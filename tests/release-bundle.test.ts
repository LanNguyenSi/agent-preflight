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
      expect(tarListing).toContain("src/cli.ts");
      expect(tarListing).toContain("Dockerfile");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
