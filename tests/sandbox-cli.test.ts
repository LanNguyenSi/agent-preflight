/**
 * End-to-end tests for `preflight sandbox`, spawning the real built CLI:
 *  - `--no-audit` / `--no-secrets` reach the printed docker command
 *  - a missing docker binary and a missing sandbox Dockerfile are reported as
 *    a single `preflight: <message>` line with exit code 1 and no stack trace
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");

let tmpRoot: string;
let workspace: string;
let emptyBin: string;

beforeAll(() => {
  // CI runs `vitest run` without a preceding build, so build here.
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preflight-sandbox-cli-")));
  workspace = path.join(tmpRoot, "workspace");
  emptyBin = path.join(tmpRoot, "empty-bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(emptyBin);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "w" }));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function runCli(cliPath: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, PREFLIGHT_CONFIG: "", HOME: tmpRoot, ...env },
  });
}

describe("preflight sandbox (built CLI)", () => {
  it("passes --no-audit and --no-secrets into the printed docker command", () => {
    const result = runCli(path.join(DIST_DIR, "cli.js"), [
      "sandbox",
      "--print",
      "--no-audit",
      "--no-secrets",
      workspace,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--no-audit/);
    expect(result.stdout).toMatch(/--no-secrets/);
  });

  it("omits both flags when they are not given", () => {
    const result = runCli(path.join(DIST_DIR, "cli.js"), ["sandbox", "--print", workspace]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/--no-audit/);
    expect(result.stdout).not.toMatch(/--no-secrets/);
  });

  it("reports a missing docker binary as one preflight line with exit 1", () => {
    const result = runCli(path.join(DIST_DIR, "cli.js"), ["sandbox", workspace], {
      PATH: emptyBin,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("preflight: Docker is not installed or not available in PATH.\n");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("reports a missing sandbox Dockerfile as one preflight line with exit 1", () => {
    // A package root that has dist/ and node_modules but no Dockerfile,
    // like an npm install of the package.
    const fakeRoot = path.join(tmpRoot, "no-dockerfile-pkg");
    fs.mkdirSync(fakeRoot);
    fs.cpSync(DIST_DIR, path.join(fakeRoot, "dist"), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(fakeRoot, "node_modules"), "dir");
    fs.writeFileSync(path.join(fakeRoot, "package.json"), fs.readFileSync(path.join(REPO_ROOT, "package.json")));

    const result = runCli(path.join(fakeRoot, "dist", "cli.js"), ["sandbox", "--print", workspace]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`preflight: Sandbox Dockerfile not found in ${fakeRoot}.\n`);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
