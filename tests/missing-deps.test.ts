import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runLintChecks } from "../src/checks/lint.js";
import { runTypecheckChecks } from "../src/checks/typecheck.js";
import { runTestChecks } from "../src/checks/test.js";
import { runPreflight } from "../src/runner.js";

const HINT = "dependencies not installed; run with --setup or install first";
const tempDirs: string[] = [];
const originalPath = process.env.PATH;

// A throwaway Node project whose `npm`/`npx` are shims that record each call
// and exit 1, so a check that really runs shows up as a `fail` and a check
// that was held back shows up as no recorded call.
function makeRepo(opts: { installed: boolean; dependencies?: Record<string, string> }): { repoPath: string; callsPath: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-missing-deps-"));
  tempDirs.push(repoPath);
  const binDir = path.join(repoPath, ".bin");
  const callsPath = path.join(repoPath, "calls.txt");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" },
      devDependencies: opts.dependencies ?? { vitest: "^1.0.0" },
    })
  );
  fs.writeFileSync(path.join(repoPath, "tsconfig.json"), "{}");
  if (opts.installed) fs.mkdirSync(path.join(repoPath, "node_modules"));
  for (const command of ["npm", "npx"]) {
    fs.writeFileSync(
      path.join(binDir, command),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${command} '"$*" >> '${callsPath}'\nexit 1\n`,
      { mode: 0o755 }
    );
  }
  process.env.PATH = `${binDir}:${originalPath}`;
  return { repoPath, callsPath };
}

const readCalls = (callsPath: string): string => (fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "");
const logDir = (repoPath: string): string => path.join(repoPath, ".preflight-test-logs");

afterEach(() => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("missing installed dependencies", () => {
  it("reports npm-test as a skip with an install hint, without running it", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    const result = await runTestChecks(repoPath, { logDir: logDir(repoPath) });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "npm-test", kind: "test", status: "skip" });
    expect(result.checks[0].message).toContain(HINT);
    expect(result.limitations).toEqual([expect.stringContaining(HINT)]);
    expect(readCalls(callsPath)).toBe("");
  });

  it("reports tsc as a skip with an install hint, without running it", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "^5.0.0" } })
    );
    const result = await runTypecheckChecks(repoPath, { logDir: logDir(repoPath) });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "tsc", kind: "typecheck", status: "skip" });
    expect(result.checks[0].message).toContain(HINT);
    expect(result.limitations).toEqual([expect.stringContaining(HINT)]);
    expect(readCalls(callsPath)).toBe("");
  });

  it("reports npm-typecheck and npm-lint the same way", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: false });
    const typecheck = await runTypecheckChecks(repoPath, { logDir: logDir(repoPath) });
    const lint = await runLintChecks(repoPath, { logDir: logDir(repoPath) });

    expect(typecheck.checks.map((c) => [c.name, c.status])).toEqual([["npm-typecheck", "skip"]]);
    expect(lint.checks.map((c) => [c.name, c.status])).toEqual([["npm-lint", "skip"]]);
    expect(readCalls(callsPath)).toBe("");
  });

  it("does not let the skipped checks make the run ready, but does not block it either", async () => {
    const { repoPath } = makeRepo({ installed: false });
    const config = { logDir: logDir(repoPath), checks: { gitState: false, audit: false, secretDetection: false, commitConvention: false, tdd: false } };

    const result = await runPreflight(repoPath, config);
    expect(result.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(result.checks.every((c) => c.status === "skip")).toBe(true);
    expect(result.limitations.filter((l) => l.includes(HINT))).toHaveLength(3);
    expect(result.confidence).toBe(0);

    const required = await runPreflight(repoPath, { ...config, requiredChecks: ["test"] });
    expect(required.ready).toBe(false);
  });

  it("runs the checks as before once node_modules exists", async () => {
    const { repoPath, callsPath } = makeRepo({ installed: true });
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath) });
    const typecheck = await runTypecheckChecks(repoPath, { logDir: logDir(repoPath) });
    const lint = await runLintChecks(repoPath, { logDir: logDir(repoPath) });

    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
    expect(typecheck.checks.map((c) => [c.name, c.status])).toEqual([["npm-typecheck", "fail"]]);
    expect(lint.checks.map((c) => [c.name, c.status])).toEqual([["npm-lint", "fail"]]);
    expect(readCalls(callsPath)).toContain("npm run test");
    expect([...test.limitations, ...typecheck.limitations, ...lint.limitations].join("\n")).not.toContain(HINT);
  });

  it("runs the checks as before when the project declares no dependencies", async () => {
    const { repoPath } = makeRepo({ installed: false, dependencies: {} });
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath) });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
  });

  it("runs the checks when --setup is enabled, even before the install exists", async () => {
    const { repoPath } = makeRepo({ installed: false });
    const test = await runTestChecks(repoPath, { logDir: logDir(repoPath), setup: { enabled: true } });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
  });

  it("treats a node_modules in an ancestor directory (hoisted workspace install) as installed", async () => {
    const { repoPath } = makeRepo({ installed: true });
    const pkgDir = path.join(repoPath, "packages", "a");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^1.0.0" } })
    );
    const test = await runTestChecks(pkgDir, { logDir: logDir(repoPath) });
    expect(test.checks.map((c) => [c.name, c.status])).toEqual([["npm-test", "fail"]]);
  });
});
