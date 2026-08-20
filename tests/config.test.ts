import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { defaultConfig, loadConfig, validateConfig } from "../src/config.js";
import { runPreflight } from "../src/runner.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(repoPath: string, contents: unknown): void {
  fs.writeFileSync(path.join(repoPath, ".preflight.json"), JSON.stringify(contents));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("validateConfig", () => {
  // task 850903cb acceptance criterion 1: one malformed-field test per type
  // class actually present in PreflightConfig (string/boolean/array/object;
  // there is no plain `number` field in PreflightConfig, so no case for it).

  it("drops a malformed string field (logDir: 123, the reported CI-crash repro) and keeps a warning", () => {
    const { config, warnings } = validateConfig({ logDir: 123 });
    expect(config.logDir).toBeUndefined();
    expect(warnings).toEqual([
      "logDir: expected a string, got number; ignoring this field",
    ]);
  });

  it("drops a malformed boolean field (secretDetectionStrict: a string)", () => {
    const { config, warnings } = validateConfig({ secretDetectionStrict: "yes" });
    expect(config.secretDetectionStrict).toBeUndefined();
    expect(warnings).toEqual([
      "secretDetectionStrict: expected a boolean, got string; ignoring this field",
    ]);
  });

  it("drops a malformed array field (protectedBranches: a string instead of string[])", () => {
    const { config, warnings } = validateConfig({ protectedBranches: "main" });
    expect(config.protectedBranches).toBeUndefined();
    expect(warnings).toEqual([
      "protectedBranches: expected an array of strings, got string; ignoring this field",
    ]);
  });

  it("drops a malformed array field whose elements are the wrong type (actFlags: [1, 2])", () => {
    const { config, warnings } = validateConfig({ actFlags: [1, 2] });
    expect(config.actFlags).toBeUndefined();
    expect(warnings).toEqual([
      "actFlags: expected an array of strings, got array; ignoring this field",
    ]);
  });

  it("drops a malformed object field (setup: a string instead of an object)", () => {
    const { config, warnings } = validateConfig({ setup: "yes" });
    expect(config.setup).toBeUndefined();
    expect(warnings).toEqual([
      "setup: expected an object, got string; ignoring this field",
    ]);
  });

  it("drops a malformed enum field (commitConvention: not one of the allowed values)", () => {
    const { config, warnings } = validateConfig({ commitConvention: "yolo" });
    expect(config.commitConvention).toBeUndefined();
    expect(warnings).toEqual([
      "commitConvention: expected one of conventional, none, got string; ignoring this field",
    ]);
  });

  it("ignores the whole file when the top-level JSON value is not an object", () => {
    const { config, warnings } = validateConfig([1, 2, 3]);
    expect(config).toEqual({});
    expect(warnings).toEqual([
      "expected an object at the top level, got array; ignoring the whole file",
    ]);
  });

  it("drops only the malformed sub-field of a nested object, keeping the valid sibling", () => {
    const { config, warnings } = validateConfig({
      sandbox: { aptPackages: ["php-intl"], pipPackages: 42 },
    });
    expect(config.sandbox).toEqual({ aptPackages: ["php-intl"] });
    expect(warnings).toEqual([
      "sandbox.pipPackages: expected an array of strings, got number; ignoring this field",
    ]);
  });

  it("drops the whole nested object field when it is not an object (checks: a string)", () => {
    const { config, warnings } = validateConfig({ checks: "nope" });
    expect(config.checks).toBeUndefined();
    expect(warnings).toEqual([
      "checks: expected an object, got string; ignoring this field",
    ]);
  });

  it("drops one malformed checks.<kind> toggle, keeping valid sibling toggles", () => {
    const { config, warnings } = validateConfig({
      checks: { lint: false, audit: "always" },
    });
    expect(config.checks).toEqual({ lint: false });
    expect(warnings).toEqual([
      "checks.audit: expected a boolean or an object, got string; ignoring this field",
    ]);
  });

  it("drops a malformed customChecks entry (non-string command) but keeps a valid entry", () => {
    const { config, warnings } = validateConfig({
      customChecks: [
        { name: "good", command: "echo ok" },
        { name: "bad", command: 42 },
      ],
    });
    expect(config.customChecks).toEqual([{ name: "good", command: "echo ok" }]);
    expect(warnings).toEqual([
      'customChecks[1]: "name" and "command" must be strings; dropping this entry',
    ]);
  });

  it("drops customChecks entirely when it is not an array", () => {
    const { config, warnings } = validateConfig({ customChecks: { name: "x" } });
    expect(config.customChecks).toBeUndefined();
    expect(warnings).toEqual([
      "customChecks: expected an array, got object; ignoring this field",
    ]);
  });

  it("leaves a fully valid config untouched with no warnings (out of scope: no behavior change for valid configs)", () => {
    const valid = {
      checks: { lint: false, audit: { acknowledge: "flaky in this repo" }, ciSimulation: true },
      tddExceptions: ["**/*.gen.ts"],
      secretAllowlist: ["fixtures/"],
      secretDetectionStrict: true,
      protectedBranches: ["main"],
      logDir: "custom-logs",
      actFlags: ["--pull=never"],
      commitConvention: "none" as const,
      workingDir: "apps/api",
      setup: { enabled: true },
      commands: { test: ["true"] },
      sandbox: { aptPackages: ["php-intl"], pipPackages: [] },
      customChecks: [{ name: "smoke", command: "echo ok", failOnError: false }],
    };

    const { config, warnings } = validateConfig(valid);
    expect(config).toEqual(valid);
    expect(warnings).toEqual([]);
  });
});

describe("loadConfig malformed field handling (integration)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns and falls back to defaults per-field instead of crashing loadConfig itself", () => {
    const repoPath = makeTempDir("preflight-config-malformed-");
    writeConfig(repoPath, {
      logDir: 123,
      secretDetectionStrict: "yes",
      protectedBranches: "main",
      setup: "yes",
      workingDir: "apps/api",
    });

    const config = loadConfig(repoPath);

    // Malformed fields fall back to defaultConfig()'s values.
    const defaults = defaultConfig();
    expect(config.logDir).toBe(defaults.logDir);
    expect(config.secretDetectionStrict).toBe(defaults.secretDetectionStrict);
    expect(config.protectedBranches).toEqual(defaults.protectedBranches);
    expect(config.setup).toEqual(defaults.setup);
    // The one valid sibling field in the same file is unaffected.
    expect(config.workingDir).toBe("apps/api");

    expect(warnSpy).toHaveBeenCalled();
    const messages: string[] = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(messages.some((m: string) => m.includes("logDir: expected a string"))).toBe(true);
    expect(messages.some((m: string) => m.includes("secretDetectionStrict: expected a boolean"))).toBe(true);
    expect(messages.some((m: string) => m.includes("protectedBranches: expected an array"))).toBe(true);
    expect(messages.some((m: string) => m.includes("setup: expected an object"))).toBe(true);
  });

  it("does not crash runPreflight on a .preflight.json with logDir:123 and one malformed field per type class (reproduces and fixes the reported CI crash)", async () => {
    const repoPath = makeTempDir("preflight-config-crash-repro-");
    writeConfig(repoPath, {
      // string field malformed (this is the exact reported repro: logDir:123
      // used to reach expandLeadingTilde()/path.isAbsolute() in runner.ts and
      // throw "value.startsWith is not a function", crashing the CLI).
      logDir: 123,
      // boolean field malformed
      secretDetectionStrict: "yes",
      // array field malformed
      protectedBranches: "main",
      // object field malformed
      setup: "yes",
      // all checks disabled so this test exercises only config loading +
      // the top-of-runPreflight logDir resolution, not the individual checks.
      checks: {
        gitState: false,
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        ciSimulation: false,
        commitConvention: false,
        secretDetection: false,
        tdd: false,
      },
    });

    const config = loadConfig(repoPath);

    await expect(runPreflight(repoPath, config)).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("keeps a valid .preflight.json's behavior unchanged (no warnings, values applied)", () => {
    const repoPath = makeTempDir("preflight-config-valid-");
    writeConfig(repoPath, {
      workingDir: "apps/api",
      checks: { audit: false },
      commands: { test: ["true"] },
    });

    const config = loadConfig(repoPath);

    expect(config.workingDir).toBe("apps/api");
    expect(config.checks?.audit).toBe(false);
    expect(config.checks?.gitState).toBe(true);
    expect(config.commands?.test).toEqual(["true"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
