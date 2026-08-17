import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runShellCheck } from "../src/checks/shared.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

describe("runShellCheck missing-binary pre-check", () => {
  let repoPath: string;
  // Every runShellCheck() call below MUST override logDir: a failing check
  // (e.g. "bash-wrapper") persists its full output via
  // computeFailureDetails/persistFailureOutput, which falls back to the
  // real ~/.agent-preflight/logs when logDir is omitted (see the
  // ShellCheckOptions.logDir docblock in src/checks/shared.ts). Routing it
  // inside repoPath means the existing afterAll cleanup removes it for free.
  let logDir: string;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-runshellcheck-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    logDir = path.join(repoPath, ".preflight-test-logs");
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("returns limitation when primary binary is truly missing", async () => {
    const result = await runShellCheck({
      repoPath,
      logDir,
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
      logDir,
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
      logDir,
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
      logDir,
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
      logDir,
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

// Wrapper invocations: `npm run X` and `composer run X` look fine to the
// primary-binary pre-check (npm/composer themselves are installed) but the
// script inside can call a tool that is missing. The opt-in flag
// `treatToolNotFoundAsLimitation` enables a post-hoc match against the
// specific patterns shells emit in that case.
describe("runShellCheck treatToolNotFoundAsLimitation (wrapper invocations)", () => {
  let repoPath: string;
  // See the matching comment on the describe block above: every fail-status
  // call here (e.g. "npm-error-envelope-only", "real-violations") persists
  // its output via computeFailureDetails and MUST override logDir, or it
  // writes into the real ~/.agent-preflight/logs.
  let logDir: string;

  beforeAll(async () => {
    repoPath = path.join(os.tmpdir(), `preflight-wrapper-missing-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    logDir = path.join(repoPath, ".preflight-test-logs");
  });

  afterAll(async () => {
    if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("reclassifies a wrapper exit when output contains `: command not found`", async () => {
    // Simulates `npm run lint` where the script `eslint src/` runs but
    // eslint is not on PATH. bash prints `... command not found` and the
    // outer command exits non-zero. With the flag set, this becomes a
    // limitation, not a fail.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "missing-via-wrapper",
      kind: "lint",
      command: "bash -c 'definitely-not-installed-xyz123 src/'",
      weight: 0.1,
      failureMessage: "lint failed",
      missingLimitation: "wrapper script invokes a missing tool; skipped",
      treatToolNotFoundAsLimitation: true,
    });

    expect(result.limitation).toBe("wrapper script invokes a missing tool; skipped");
    expect(result.check).toBeUndefined();
  });

  it("reclassifies real-world npm-wrapped failure that includes an underlying sh `: Permission denied` line", async () => {
    // Reproduces the agent-tasks 2026-05-17 case: npm run lint -> sh -> eslint,
    // where eslint is not installed and bash emits `sh: 1: eslint: Permission denied`
    // before npm prints its own `npm error code 127` envelope. The sh line is
    // what the heuristic anchors on.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "npm-wrapped-real",
      kind: "lint",
      command:
        "bash -c 'echo \"sh: 1: eslint: Permission denied\" >&2; echo \"npm error code 127\" >&2; exit 1'",
      weight: 0.1,
      failureMessage: "npm lint failed",
      missingLimitation: "npm script invokes a missing tool; skipped",
      treatToolNotFoundAsLimitation: true,
    });

    expect(result.limitation).toBe("npm script invokes a missing tool; skipped");
    expect(result.check).toBeUndefined();
  });

  it("does NOT reclassify when only the npm-error envelope is present (no underlying sh line)", async () => {
    // Preserves the existing workspace-test contract: a deliberate `exit 127`
    // inside a workspace script causes npm to print `npm error code 127` but
    // there is no `sh: ...: command not found` line, so it must remain a fail.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "npm-error-envelope-only",
      kind: "lint",
      command: "bash -c 'echo \"npm error code 127\" >&2; exit 1'",
      weight: 0.1,
      failureMessage: "npm lint failed",
      missingLimitation: "should not fire",
      treatToolNotFoundAsLimitation: true,
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("fail");
  });

  it("does NOT reclassify when the flag is not set, even if output matches", async () => {
    // Conservative-by-default contract: no flag, no reclassification.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "no-flag",
      kind: "lint",
      command: "bash -c 'definitely-not-installed-xyz456 src/'",
      weight: 0.1,
      failureMessage: "lint failed",
      missingLimitation: "should not be used",
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("fail");
  });

  it("does NOT reclassify a real lint violation (non-matching output)", async () => {
    // Simulates eslint finding real violations: exit 1, no `command not
    // found` in output, no `npm error code 127`. Must remain a fail.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "real-violations",
      kind: "lint",
      command: "bash -c 'echo \"src/foo.ts:5:1: error: missing-semi\" >&2; exit 1'",
      weight: 0.1,
      failureMessage: "lint failed",
      missingLimitation: "should not fire",
      treatToolNotFoundAsLimitation: true,
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("fail");
  });

  it("does NOT reclassify bare `exit 127` with no output (preserves the existing nested-127 contract)", async () => {
    // The other test asserts the no-flag version of this; here we also
    // verify the flagged path: empty output means no pattern match, so the
    // failure stays a fail.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "bare-127-flagged",
      kind: "lint",
      command: "bash -c 'exit 127'",
      weight: 0.1,
      failureMessage: "lint failed",
      missingLimitation: "should not fire",
      treatToolNotFoundAsLimitation: true,
    });

    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("fail");
  });

  it("does NOT match a violation string that happens to contain `command not found` as content", async () => {
    // A linter rule named "command-not-found" in its own diagnostic must
    // not trigger the heuristic. The regex is anchored to end-of-line and
    // requires a colon+space before, which a free-text mention will not
    // satisfy.
    const result = await runShellCheck({
      repoPath,
      logDir,
      name: "false-positive-guard",
      kind: "lint",
      command: "bash -c 'echo \"rule check: command not found in our style guide is a warn\" >&2; exit 1'",
      weight: 0.1,
      failureMessage: "lint failed",
      missingLimitation: "should not fire",
      treatToolNotFoundAsLimitation: true,
    });

    // The matcher requires `: command not found` at end of line.
    // The example above has trailing text after, so it should NOT match.
    expect(result.limitation).toBeUndefined();
    expect(result.check?.status).toBe("fail");
  });
});
