import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runPreflight } from "../src/runner.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { execSync } from "child_process";

describe("npm workspace support", () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-workspace-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });

    await fs.writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({
        name: "ws-root",
        private: true,
        workspaces: ["pkg-a"],
        scripts: {
          typecheck: "npm run typecheck --workspace=pkg-a",
          lint: "npm run lint --workspace=pkg-a",
        },
      })
    );

    const pkgA = path.join(repoPath, "pkg-a");
    await fs.mkdir(path.join(pkgA, "src"), { recursive: true });
    await fs.writeFile(
      path.join(pkgA, "package.json"),
      JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
        scripts: {
          typecheck: 'echo "typecheck ok"',
          lint: 'echo "lint ok"',
        },
      })
    );
    await fs.writeFile(path.join(pkgA, "src", "index.ts"), "export const a = 1;\n");

    execSync("git init -q", { cwd: repoPath });
    execSync('git config user.email "t@example.com"', { cwd: repoPath });
    execSync('git config user.name "T"', { cwd: repoPath });
    execSync("git add .", { cwd: repoPath });
    execSync('git commit -qm "feat: init"', { cwd: repoPath });
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("runs root typecheck script when root has no tsconfig but workspaces do", async () => {
    const result = await runPreflight(repoPath, {
      checks: {
        typecheck: true,
        lint: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
        tdd: false,
      },
    });

    const typecheck = result.checks.find((c) => c.kind === "typecheck");
    expect(typecheck, "typecheck check should have run via root script").toBeDefined();
    expect(typecheck?.status).toBe("pass");
    expect(
      result.limitations.some((l) => l.includes("No tsconfig.json found")),
      "must NOT silently skip with 'No tsconfig.json found' when scripts.typecheck is present"
    ).toBe(false);
  });

  it("surfaces nested test failures as fail, not as 'npm not installed' limitation", async () => {
    const brokenRoot = path.join(os.tmpdir(), `preflight-ws-test-broken-${Date.now()}`);
    await fs.mkdir(path.join(brokenRoot, "pkg-a"), { recursive: true });
    await fs.writeFile(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: "r",
        private: true,
        workspaces: ["pkg-a"],
        scripts: { test: "npm run test --workspace=pkg-a" },
      })
    );
    await fs.writeFile(
      path.join(brokenRoot, "pkg-a", "package.json"),
      JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
        scripts: { test: "exit 127" },
      })
    );
    execSync("git init -q", { cwd: brokenRoot });
    execSync('git config user.email "t@example.com"', { cwd: brokenRoot });
    execSync('git config user.name "T"', { cwd: brokenRoot });
    execSync("git add .", { cwd: brokenRoot });
    execSync('git commit -qm "x"', { cwd: brokenRoot });

    try {
      const result = await runPreflight(brokenRoot, {
        checks: {
          lint: false,
          typecheck: false,
          test: true,
          audit: false,
          secretDetection: false,
          commitConvention: false,
          ciSimulation: false,
          tdd: false,
        },
      });

      const testCheck = result.checks.find((c) => c.kind === "test");
      expect(testCheck, "test check must appear").toBeDefined();
      expect(testCheck?.status).toBe("fail");
      expect(
        result.limitations.some((l) => l.includes("npm not installed")),
        "127 from a nested workspace test script must NOT be reported as 'npm not installed'"
      ).toBe(false);
    } finally {
      await fs.rm(brokenRoot, { recursive: true, force: true });
    }
  });

  it("surfaces nested lint failures as fail, not as 'npm not installed' limitation", async () => {
    const brokenRoot = path.join(os.tmpdir(), `preflight-ws-broken-${Date.now()}`);
    await fs.mkdir(path.join(brokenRoot, "pkg-a"), { recursive: true });
    await fs.writeFile(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: "r",
        private: true,
        workspaces: ["pkg-a"],
        scripts: { lint: "npm run lint --workspace=pkg-a" },
      })
    );
    await fs.writeFile(
      path.join(brokenRoot, "pkg-a", "package.json"),
      JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
        scripts: { lint: "exit 127" },
      })
    );
    execSync("git init -q", { cwd: brokenRoot });
    execSync('git config user.email "t@example.com"', { cwd: brokenRoot });
    execSync('git config user.name "T"', { cwd: brokenRoot });
    execSync("git add .", { cwd: brokenRoot });
    execSync('git commit -qm "x"', { cwd: brokenRoot });

    try {
      const result = await runPreflight(brokenRoot, {
        checks: {
          lint: true,
          typecheck: false,
          test: false,
          audit: false,
          secretDetection: false,
          commitConvention: false,
          ciSimulation: false,
          tdd: false,
        },
      });

      const lint = result.checks.find((c) => c.kind === "lint");
      expect(lint, "lint check must appear").toBeDefined();
      expect(lint?.status).toBe("fail");
      expect(
        result.limitations.some((l) => l.includes("npm not installed")),
        "127 from a nested workspace script must NOT be reported as 'npm not installed'"
      ).toBe(false);
    } finally {
      await fs.rm(brokenRoot, { recursive: true, force: true });
    }
  });
});
