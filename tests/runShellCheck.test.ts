import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runShellCheck } from "../src/checks/shared.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

describe("runShellCheck missing-binary pre-check", () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-runshellcheck-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("returns limitation when primary binary is truly missing", async () => {
    const result = await runShellCheck({
      repoPath,
      name: "nonexistent-tool",
      kind: "lint",
      command: "definitely-not-a-real-binary-xyz123 --foo",
      weight: 0.1,
      failureMessage: "should not fire",
      missingLimitation: "tool xyz not installed; skipped",
    });

    expect(result.limitation).toBe("tool xyz not installed; skipped");
    expect(result.check).toBeUndefined();
  });

  it("returns real fail when binary exists but command exits non-zero (including 127 from nested)", async () => {
    const result = await runShellCheck({
      repoPath,
      name: "bash-wrapper",
      kind: "lint",
      command: "bash -c 'exit 127'",
      weight: 0.1,
      failureMessage: "nested 127 should surface as fail",
      missingLimitation: "bash not installed; skipped",
    });

    expect(result.limitation, "bash is installed, so 127 from nested child must NOT become limitation").toBeUndefined();
    expect(result.check).toBeDefined();
    expect(result.check?.status).toBe("fail");
  });

  it("returns pass when binary exists and command succeeds", async () => {
    const result = await runShellCheck({
      repoPath,
      name: "true-command",
      kind: "lint",
      command: "true",
      weight: 0.1,
      failureMessage: "should not fire",
      missingLimitation: "true not installed; skipped",
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("pass");
  });

  it("pre-checks ./-prefixed primaries like ./mvnw at repo root", async () => {
    const wrapper = path.join(repoPath, "mvnw-test");
    await fs.writeFile(wrapper, "#!/bin/sh\nexit 0\n");
    await fs.chmod(wrapper, 0o755);

    const result = await runShellCheck({
      repoPath,
      name: "mvnw-like",
      kind: "typecheck",
      command: "./mvnw-test -q compile",
      weight: 0.1,
      failureMessage: "should not fire",
      missingLimitation: "mvnw not available",
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("pass");
  });

  it("pre-checks path-qualified primaries like vendor/bin/phpstan", async () => {
    // Create an executable stub at vendor/bin/tool and verify it's found.
    const toolDir = path.join(repoPath, "vendor", "bin");
    await fs.mkdir(toolDir, { recursive: true });
    const toolPath = path.join(toolDir, "tool");
    await fs.writeFile(toolPath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(toolPath, 0o755);

    const result = await runShellCheck({
      repoPath,
      name: "path-qualified",
      kind: "lint",
      command: "vendor/bin/tool --check",
      weight: 0.1,
      failureMessage: "should not fire",
      missingLimitation: "tool not installed",
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("pass");
  });
});
