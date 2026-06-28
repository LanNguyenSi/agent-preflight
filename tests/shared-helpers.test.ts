/**
 * Tests for src/checks/shared.ts helpers (LOW-priority coverage gap).
 *
 * Covers: createProjectContext (multi-language detection), hasNodeProject,
 * hasNodeDependency, hasPythonProject, hasPhpProject, hasJavaProject,
 * shouldSkipRecursiveNodeTest, getConfiguredCommands.
 *
 * Uses real temp directories — no mocks needed for these pure helpers.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectContext,
  getConfiguredCommands,
  hasJavaProject,
  hasNodeDependency,
  hasNodeProject,
  hasPhpProject,
  hasPythonProject,
  shouldSkipRecursiveNodeTest,
} from "../src/checks/shared.js";
import type { PreflightConfig } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "preflight-shared-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(dir: string, filename: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── createProjectContext ──────────────────────────────────────────────────────

describe("createProjectContext", () => {
  it("returns minimal context for an empty directory", () => {
    const dir = makeTempDir();
    const ctx = createProjectContext(dir);

    expect(ctx.repoPath).toBe(dir);
    expect(ctx.packageJson).toBeUndefined();
    expect(ctx.composerJson).toBeUndefined();
    expect(ctx.hasPyproject).toBe(false);
    expect(ctx.hasSetupPy).toBe(false);
    expect(ctx.hasRequirementsTxt).toBe(false);
    expect(ctx.hasTsconfig).toBe(false);
    expect(ctx.hasPomXml).toBe(false);
    expect(ctx.hasMavenWrapper).toBe(false);
    expect(ctx.hasGradleBuild).toBe(false);
    expect(ctx.hasGradleWrapper).toBe(false);
  });

  it("detects a Node project from package.json", () => {
    const dir = makeTempDir();
    writeJson(dir, "package.json", { name: "my-app", version: "1.0.0" });

    const ctx = createProjectContext(dir);
    expect(ctx.packageJson).toBeDefined();
    expect(hasNodeProject(ctx)).toBe(true);
  });

  it("detects a TypeScript project from tsconfig.json", () => {
    const dir = makeTempDir();
    writeJson(dir, "package.json", { name: "ts-app" });
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");

    const ctx = createProjectContext(dir);
    expect(ctx.hasTsconfig).toBe(true);
  });

  it("detects a Python project from requirements.txt", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "requirements.txt"), "flask\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasRequirementsTxt).toBe(true);
    expect(hasPythonProject(ctx)).toBe(true);
  });

  it("detects a Python project from pyproject.toml", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.poetry]\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasPyproject).toBe(true);
    expect(hasPythonProject(ctx)).toBe(true);
  });

  it("detects a Python project from setup.py", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "setup.py"), "from setuptools import setup\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasSetupPy).toBe(true);
    expect(hasPythonProject(ctx)).toBe(true);
  });

  it("detects a PHP project from composer.json", () => {
    const dir = makeTempDir();
    writeJson(dir, "composer.json", { require: { php: ">=8.0" } });

    const ctx = createProjectContext(dir);
    expect(ctx.composerJson).toBeDefined();
    expect(hasPhpProject(ctx)).toBe(true);
  });

  it("detects a Java project from pom.xml", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasPomXml).toBe(true);
    expect(hasJavaProject(ctx)).toBe(true);
  });

  it("detects a Java project from Maven wrapper", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "mvnw"), "#!/bin/sh\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasMavenWrapper).toBe(true);
    expect(hasJavaProject(ctx)).toBe(true);
  });

  it("detects a Java project from build.gradle", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "build.gradle"), "plugins {}\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasGradleBuild).toBe(true);
    expect(hasJavaProject(ctx)).toBe(true);
  });

  it("detects a Java project from build.gradle.kts", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "build.gradle.kts"), "plugins {}\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasGradleBuild).toBe(true);
    expect(hasJavaProject(ctx)).toBe(true);
  });

  it("detects a Java project from gradlew wrapper", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "gradlew"), "#!/bin/sh\n");

    const ctx = createProjectContext(dir);
    expect(ctx.hasGradleWrapper).toBe(true);
    expect(hasJavaProject(ctx)).toBe(true);
  });

  it("detects a multi-language repo (Node + Python + PHP + Java)", () => {
    const dir = makeTempDir();
    writeJson(dir, "package.json", { name: "polyglot" });
    fs.writeFileSync(path.join(dir, "requirements.txt"), "django\n");
    writeJson(dir, "composer.json", { require: {} });
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>\n");

    const ctx = createProjectContext(dir);
    expect(hasNodeProject(ctx)).toBe(true);
    expect(hasPythonProject(ctx)).toBe(true);
    expect(hasPhpProject(ctx)).toBe(true);
    expect(hasJavaProject(ctx)).toBe(true);
  });
});

// ── hasNodeDependency ─────────────────────────────────────────────────────────

describe("hasNodeDependency", () => {
  it("returns true for a production dependency", () => {
    const dir = makeTempDir();
    writeJson(dir, "package.json", { dependencies: { react: "^18.0.0" } });
    const ctx = createProjectContext(dir);
    expect(hasNodeDependency(ctx, "react")).toBe(true);
  });

  it("returns true for a dev dependency", () => {
    const dir = makeTempDir();
    writeJson(dir, "package.json", { devDependencies: { vitest: "^4.0.0" } });
    const ctx = createProjectContext(dir);
    expect(hasNodeDependency(ctx, "vitest")).toBe(true);
  });

  it("returns false when the dependency is not present", () => {
    const dir = makeTempDir();
    writeJson(dir, "package.json", { dependencies: { lodash: "^4.0.0" } });
    const ctx = createProjectContext(dir);
    expect(hasNodeDependency(ctx, "nonexistent-pkg")).toBe(false);
  });

  it("returns false when there is no package.json", () => {
    const dir = makeTempDir();
    const ctx = createProjectContext(dir);
    expect(hasNodeDependency(ctx, "react")).toBe(false);
  });
});

// ── shouldSkipRecursiveNodeTest ───────────────────────────────────────────────

describe("shouldSkipRecursiveNodeTest", () => {
  it("returns false for non-node-test commands regardless of VITEST env", () => {
    // This function short-circuits on !process.env.VITEST — but since we're
    // running inside vitest, VITEST IS set. Still, non-test commands should
    // return false even when VITEST is set and the path is the same cwd.
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "npm run build")).toBe(false);
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "eslint src")).toBe(false);
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "tsc --noEmit")).toBe(false);
  });

  it("returns true for vitest commands pointing at the current working directory", () => {
    // VITEST is set (we're in a test run) and path resolves to cwd
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "vitest")).toBe(true);
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "npx vitest")).toBe(true);
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "npm test")).toBe(true);
    expect(shouldSkipRecursiveNodeTest(process.cwd(), "npm run test")).toBe(true);
  });

  it("returns false for vitest commands when repoPath differs from cwd", () => {
    const otherDir = os.tmpdir();
    expect(shouldSkipRecursiveNodeTest(otherDir, "vitest")).toBe(false);
    expect(shouldSkipRecursiveNodeTest(otherDir, "npm test")).toBe(false);
  });
});

// ── getConfiguredCommands ─────────────────────────────────────────────────────

describe("getConfiguredCommands", () => {
  it("returns the configured lint commands", () => {
    const config: PreflightConfig = { commands: { lint: ["eslint src", "npm run lint:style"] } };
    expect(getConfiguredCommands(config, "lint")).toEqual(["eslint src", "npm run lint:style"]);
  });

  it("returns the configured test commands", () => {
    const config: PreflightConfig = { commands: { test: ["vitest run"] } };
    expect(getConfiguredCommands(config, "test")).toEqual(["vitest run"]);
  });

  it("returns an empty array when the kind is not configured", () => {
    const config: PreflightConfig = { commands: { lint: ["eslint ."] } };
    expect(getConfiguredCommands(config, "test")).toEqual([]);
  });

  it("returns an empty array when commands is undefined", () => {
    const config: PreflightConfig = {};
    expect(getConfiguredCommands(config, "lint")).toEqual([]);
  });

  it("returns configured audit commands", () => {
    const config: PreflightConfig = { commands: { audit: ["npm audit --audit-level=high"] } };
    expect(getConfiguredCommands(config, "audit")).toEqual(["npm audit --audit-level=high"]);
  });
});
