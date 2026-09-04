import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runLintChecks } from "../src/checks/lint.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function makeRepo(packageJson: Record<string, unknown>): { repoPath: string; callsPath: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-lint-"));
  tempDirs.push(repoPath);
  const binDir = path.join(repoPath, ".bin");
  const callsPath = path.join(repoPath, "calls.txt");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify(packageJson));

  for (const command of ["npm", "npx"]) {
    fs.writeFileSync(
      path.join(binDir, command),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${command} '"$*" >> '${callsPath}'\nexit 0\n`,
      { mode: 0o755 }
    );
  }
  process.env.PATH = `${binDir}:${originalPath}`;
  return { repoPath, callsPath };
}

function readCalls(callsPath: string): string {
  return fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "";
}

afterEach(() => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("lint auto-detection", () => {
  it("prefers package.json scripts.lint over dependency-detected ESLint", async () => {
    const { repoPath, callsPath } = makeRepo({
      scripts: { lint: "eslint src" },
      devDependencies: { eslint: "^9.0.0" },
    });
    fs.writeFileSync(path.join(repoPath, "eslint.config.js"), "export default [];\n");

    const result = await runLintChecks(repoPath, {});

    expect(result.checks.map((check) => check.name)).toEqual(["npm-lint"]);
    expect(readCalls(callsPath)).toContain("npm run lint");
    expect(readCalls(callsPath)).not.toContain("npx eslint");
  });

  it("reports a limitation and does not run ESLint when its config is missing", async () => {
    const { repoPath, callsPath } = makeRepo({ devDependencies: { eslint: "^9.0.0" } });

    const result = await runLintChecks(repoPath, {});

    expect(result.checks).toHaveLength(0);
    expect(result.limitations).toContain(
      "ESLint dependency found but no supported ESLint config file exists; Node lint check skipped"
    );
    expect(readCalls(callsPath)).not.toContain("eslint");
  });

  it.each([
    ["flat", "eslint.config.mjs", "npx eslint . --format json"],
    ["legacy", ".eslintrc.json", "npx eslint . --ext .ts,.tsx,.js,.jsx,.cjs,.mjs --format json"],
  ])("runs ESLint when a supported %s config exists", async (_kind, configName, expectedCommand) => {
    const { repoPath, callsPath } = makeRepo({ devDependencies: { eslint: "^9.0.0" } });
    fs.writeFileSync(path.join(repoPath, configName), "{}\n");

    const result = await runLintChecks(repoPath, {});

    expect(result.checks.map((check) => check.name)).toEqual(["eslint"]);
    expect(readCalls(callsPath)).toContain(expectedCommand);
  });
});
