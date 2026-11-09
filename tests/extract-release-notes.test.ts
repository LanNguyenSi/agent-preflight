import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "extract-release-notes.sh");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runExtract(args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync("bash", [scriptPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-release-notes-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("extract-release-notes.sh", () => {
  it("extracts a middle section exactly, heading and next section excluded", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      const out = path.join(dir, "notes.md");
      fs.writeFileSync(
        changelog,
        [
          "# Changelog",
          "",
          "## [1.2.3] - 2026-01-02",
          "",
          "### Fixed",
          "",
          "- Middle item.",
          "",
          "## [1.2.2] - 2026-01-01",
          "",
          "- Later item, must not appear.",
          "",
        ].join("\n")
      );

      const result = runExtract(["1.2.3", changelog, out], dir);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(out, "utf-8")).toBe("\n### Fixed\n\n- Middle item.\n\n");
    });
  });

  it("extracts the last section when no following heading exists", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      const out = path.join(dir, "notes.md");
      fs.writeFileSync(
        changelog,
        [
          "## [1.0.0] - 2026-01-01",
          "",
          "- First item.",
          "",
          "## [0.9.0] - 2025-12-01",
          "",
          "### Added",
          "",
          "- Last item.",
        ].join("\n")
      );

      const result = runExtract(["0.9.0", changelog, out], dir);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(out, "utf-8")).toBe("\n### Added\n\n- Last item.\n");
    });
  });

  it("fails for 0.12.1 when the file only has 0.12.10 and writes no file", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      const out = path.join(dir, "notes.md");
      fs.writeFileSync(
        changelog,
        ["## [0.12.10] - 2026-11-01", "", "- Ten item.", ""].join("\n")
      );

      const result = runExtract(["0.12.1", changelog, out], dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no section for version 0.12.1");
      expect(fs.existsSync(out)).toBe(false);
    });
  });

  it("does not match a regex look-alike heading against literal dots", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      const out = path.join(dir, "notes.md");
      fs.writeFileSync(
        changelog,
        [
          "## [0x12y1] - 2026-11-01",
          "",
          "- Look-alike item, must not be treated as 0.12.1.",
          "",
        ].join("\n")
      );

      const result = runExtract(["0.12.1", changelog, out], dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no section for version 0.12.1");
      expect(fs.existsSync(out)).toBe(false);
    });
  });

  it("fails on a section that only has blank lines and writes no file", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      const out = path.join(dir, "notes.md");
      fs.writeFileSync(
        changelog,
        ["## [2.0.0] - 2026-02-02", "", "   ", "", "\t", "", "## [1.9.9] - 2026-01-01", "", "- Done."].join(
          "\n"
        )
      );

      const result = runExtract(["2.0.0", changelog, out], dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("empty");
      expect(fs.existsSync(out)).toBe(false);
    });
  });

  it("fails with a usage error when the version argument is missing", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      fs.writeFileSync(changelog, ["## [1.0.0] - 2026-01-01", "", "- Item.", ""].join("\n"));

      const missing = runExtract([], dir);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/usage/i);

      const empty = runExtract(["", changelog, path.join(dir, "notes.md")], dir);
      expect(empty.status).not.toBe(0);
      expect(empty.stderr).toMatch(/usage/i);
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails on an unreadable changelog and writes no file",
    () => {
      withTempDir((dir) => {
        const changelog = path.join(dir, "CHANGELOG.md");
        const out = path.join(dir, "notes.md");
        fs.writeFileSync(changelog, ["## [1.0.0] - 2026-11-01", "", "- Item.", ""].join("\n"));
        fs.chmodSync(changelog, 0o000);
        try {
          const result = runExtract(["1.0.0", changelog, out], dir);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("failed to read");
          expect(fs.existsSync(out)).toBe(false);
        } finally {
          fs.chmodSync(changelog, 0o600);
        }
      });
    }
  );

  it("fails when the output directory does not exist", () => {
    withTempDir((dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      fs.writeFileSync(changelog, ["## [1.0.0] - 2026-11-01", "", "- Item.", ""].join("\n"));
      const result = runExtract(["1.0.0", changelog, path.join(dir, "missing", "notes.md")], dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("failed to read the changelog or write");
    });
  });

  it("extracts a non-empty body for 0.12.1 from the real CHANGELOG.md", () => {
    withTempDir((dir) => {
      const out = path.join(dir, "notes.md");
      const result = runExtract(["0.12.1", path.join(repoRoot, "CHANGELOG.md"), out], dir);
      expect(result.status).toBe(0);
      const body = fs.readFileSync(out, "utf-8");
      expect(body.trim().length).toBeGreaterThan(0);
      expect(body).toContain("### Fixed");
      expect(body).not.toContain("## [0.12.0]");
    });
  });
});
