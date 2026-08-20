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

  it("drops a malformed enum field (commitConvention: not one of the allowed values) and names the received value (FIX 5)", () => {
    const { config, warnings } = validateConfig({ commitConvention: "yolo" });
    expect(config.commitConvention).toBeUndefined();
    expect(warnings).toEqual([
      'commitConvention: expected one of conventional, none, got "yolo"; ignoring this field',
    ]);
  });

  it("names a non-string enum value's TYPE only, not the value itself (pickEnum stays type-only for non-strings)", () => {
    const { config, warnings } = validateConfig({ commitConvention: 42 });
    expect(config.commitConvention).toBeUndefined();
    expect(warnings).toEqual([
      "commitConvention: expected one of conventional, none, got number; ignoring this field",
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

  // FIX 4 (task-slicer fix-round, review of task 850903cb): 5 previously
  // uncovered/mutation-survivable cases.

  it("drops commands entirely when it is not an object", () => {
    const { config, warnings } = validateConfig({ commands: "nope" });
    expect(config.commands).toBeUndefined();
    expect(warnings).toEqual([
      "commands: expected an object, got string; ignoring this field",
    ]);
  });

  it("drops sandbox entirely when it is not an object", () => {
    const { config, warnings } = validateConfig({ sandbox: "nope" });
    expect(config.sandbox).toBeUndefined();
    expect(warnings).toEqual([
      "sandbox: expected an object, got string; ignoring this field",
    ]);
  });

  it("drops a customChecks entry that isn't an object (a bare string)", () => {
    const { config, warnings } = validateConfig({ customChecks: ["echo hi"] });
    expect(config.customChecks).toEqual([]);
    expect(warnings).toEqual([
      "customChecks[0]: expected an object, got string; dropping this entry",
    ]);
  });

  it("drops a non-boolean customChecks[i].failOnError but keeps the rest of the entry (closes surviving mutant M4)", () => {
    const { config, warnings } = validateConfig({
      customChecks: [{ name: "smoke", command: "echo ok", failOnError: "yes" }],
    });
    expect(config.customChecks).toEqual([{ name: "smoke", command: "echo ok" }]);
    expect(warnings).toEqual([
      'customChecks[0].failOnError: expected a boolean, got string; ignoring this field',
    ]);
  });

  it("pins the 'got null' wording for a null field (logDir: null)", () => {
    const { config, warnings } = validateConfig({ logDir: null });
    expect(config.logDir).toBeUndefined();
    expect(warnings).toEqual([
      "logDir: expected a string, got null; ignoring this field",
    ]);
  });

  // FIX 3 (task-slicer fix-round, review of task 850903cb): unrecognized
  // keys warn instead of being silently dropped with no signal.

  it("warns about an unrecognized top-level key, naming it, without dropping recognized siblings", () => {
    const { config, warnings } = validateConfig({ chekcs: { lint: false }, workingDir: "apps/api" });
    expect(config.workingDir).toBe("apps/api");
    expect((config as Record<string, unknown>).chekcs).toBeUndefined();
    expect(warnings.some((w) => w.includes('"chekcs"'))).toBe(true);
  });

  it("warns about an unrecognized nested key inside checks/commands/sandbox/setup, naming it", () => {
    const { warnings } = validateConfig({
      checks: { lint: false, lintt: true },
      commands: { test: ["true"], tset: ["true"] },
      sandbox: { aptPackages: [], aptPackagez: [] },
      setup: { enabled: true, enalbed: true },
    });
    expect(warnings.some((w) => w.startsWith("checks:") && w.includes('"lintt"'))).toBe(true);
    expect(warnings.some((w) => w.startsWith("commands:") && w.includes('"tset"'))).toBe(true);
    expect(warnings.some((w) => w.startsWith("sandbox:") && w.includes('"aptPackagez"'))).toBe(true);
    expect(warnings.some((w) => w.startsWith("setup:") && w.includes('"enalbed"'))).toBe(true);
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

  // FIX 1 (task-slicer fix-round, review of task 850903cb): a
  // checks.secretDetection.acknowledge configured through an actual
  // .preflight.json file (via loadConfig, not built programmatically) must
  // still reach the D-013 "not supported" limitations entry. Before this
  // fix, loadConfig's own validateConfig() dropped the object-shaped
  // `secretDetection` value (checks.secretDetection was in the
  // boolean-only picker list), so this scenario silently lost the
  // documented D-013 signal; the existing runner.test.ts D-013 coverage
  // builds `config.checks` programmatically and never exercises loadConfig,
  // so it did not catch the regression.
  it("D-013: checks.secretDetection.acknowledge loaded from an actual .preflight.json file still reaches runPreflight's limitations", async () => {
    const repoPath = makeTempDir("preflight-config-d013-e2e-");
    writeConfig(repoPath, {
      checks: {
        gitState: false,
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        ciSimulation: false,
        commitConvention: false,
        tdd: false,
        secretDetection: { acknowledge: "reviewed, false positive" },
      },
    });

    const config = loadConfig(repoPath);
    // The object survives config loading instead of being dropped back to
    // defaultConfig()'s `secretDetection: true`.
    expect(config.checks?.secretDetection).toEqual({ acknowledge: "reviewed, false positive" });

    const result = await runPreflight(repoPath, config);

    expect(
      result.limitations.some((l) => l.includes("checks.secretDetection.acknowledge is not supported"))
    ).toBe(true);
  });
});
