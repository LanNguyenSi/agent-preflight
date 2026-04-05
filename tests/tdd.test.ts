import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { runTddCheck } from "../src/checks/tdd.js";
import type { PreflightConfig } from "../src/types.js";

let tmpDir: string;

function initRepo(files: Record<string, string>) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-tdd-"));
  fs.mkdirSync(path.join(tmpDir, ".git"));

  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Initialize a real git repo with user config (needed in CI where no global git identity exists) */
async function initGitRepo() {
  const { execa } = await import("execa");
  fs.rmSync(path.join(tmpDir, ".git"), { recursive: true });
  await execa("git", ["init"], { cwd: tmpDir });
  await execa("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
  await execa("git", ["config", "user.name", "Test"], { cwd: tmpDir });
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const defaultConfig: PreflightConfig = {};

describe("runTddCheck", () => {
  it("passes when no source files changed", async () => {
    initRepo({});
    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("pass");
  });

  it("warns when source file has no test counterpart", async () => {
    initRepo({
      "src/foo.ts": "export const foo = 1;",
    });

    // Create a real git repo so git diff works
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd: tmpDir });

    // Add a new file without test
    fs.writeFileSync(path.join(tmpDir, "src/bar.ts"), "export const bar = 2;");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add bar", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe("warn");
    expect(result.checks[0].details).toContain("src/bar.ts");
  });

  it("passes when source file has test counterpart", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/foo.ts"), "export const foo = 1;");
    fs.writeFileSync(path.join(tmpDir, "src/foo.test.ts"), "test('foo', () => {});");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add foo with test", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
  });

  it("skips exception files like index.ts", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/index.ts"), "export {};");
    fs.writeFileSync(path.join(tmpDir, "src/types.ts"), "export type Foo = string;");
    fs.writeFileSync(path.join(tmpDir, "src/constants.ts"), "export const X = 1;");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add exceptions", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].message).toContain("No checkable");
  });

  it("supports configurable exceptions", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/helpers.ts"), "export const h = 1;");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add helpers", "--no-gpg-sign"], { cwd: tmpDir });

    const config: PreflightConfig = { tddExceptions: ["helpers.ts"] };
    const result = await runTddCheck(tmpDir, config);
    expect(result.checks[0].status).toBe("pass");
  });

  it("finds tests in __tests__ directory", async () => {
    initRepo({});
    const { execa } = await import("execa");
    await initGitRepo();
    await execa("git", ["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, "src/__tests__"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src/foo.ts"), "export const foo = 1;");
    fs.writeFileSync(path.join(tmpDir, "src/__tests__/foo.test.ts"), "test('foo', () => {});");
    await execa("git", ["add", "."], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "add foo", "--no-gpg-sign"], { cwd: tmpDir });

    const result = await runTddCheck(tmpDir, defaultConfig);
    expect(result.checks[0].status).toBe("pass");
  });
});
