import fs from "fs";
import path from "path";
import { CheckToggle, CustomCheck, PreflightConfig, SandboxConfig } from "./types.js";

const CONFIG_FILENAME = ".preflight.json";
const DEFAULT_ACT_FLAGS = ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"];

// `checks.*` keys whose value can be `true`/`false` OR `{ acknowledge: "..." }`
// (see PreflightConfig.checks / types.ts#CheckToggle). Validated here only at
// the boolean-or-object shape level; the inner `acknowledge` string check is
// runner.ts#resolveAcknowledge's job (it already handles any shape safely and
// reports a rejected acknowledge in `limitations`), so it is deliberately not
// duplicated here.
const CHECK_TOGGLE_KEYS = [
  "gitState",
  "lint",
  "typecheck",
  "test",
  "audit",
  "commitConvention",
  "tdd",
] as const;

// `checks.*` keys that are plain booleans only (never an acknowledge object).
const CHECK_BOOLEAN_KEYS = ["ciSimulation", "secretDetection"] as const;

const COMMAND_KEYS = ["lint", "typecheck", "test", "audit"] as const;

const COMMIT_CONVENTION_VALUES = ["conventional", "none"] as const;

export interface ConfigValidationResult {
  config: Partial<PreflightConfig>;
  warnings: string[];
}

/**
 * Type-checks a JSON.parse()'d `.preflight.json` payload field-by-field
 * against `PreflightConfig`'s shape, hand-rolled (no schema library — task
 * 850903cb). Every recognized field must match its declared type; a field
 * whose value has the wrong type is dropped (never merged over the default)
 * and reported in `warnings`, so a caller can `console.warn` it instead of
 * letting the malformed value crash a downstream consumer (e.g. `logDir: 123`
 * previously reached `expandLeadingTilde`/`path.isAbsolute` in runner.ts and
 * threw a `TypeError`, crashing the CLI). A payload that isn't even a plain
 * object (e.g. an array, a string, `null`) invalidates the whole file and
 * falls back to an empty override (defaults apply everywhere).
 *
 * Valid configs are unaffected: every field that already matches its type
 * passes through unchanged, and nested defaulting (checks/setup/commands/
 * sandbox merging with `defaultConfig()`) is still done by `mergeConfig`,
 * not here.
 */
export function validateConfig(parsed: unknown): ConfigValidationResult {
  const warnings: string[] = [];

  if (!isPlainObject(parsed)) {
    warnings.push(`expected an object at the top level, got ${describeType(parsed)}; ignoring the whole file`);
    return { config: {}, warnings };
  }

  const source = parsed;
  const result: Partial<PreflightConfig> = {};

  const logDir = pickString(source, "logDir", warnings);
  if (logDir !== undefined) result.logDir = logDir;

  const workingDir = pickString(source, "workingDir", warnings);
  if (workingDir !== undefined) result.workingDir = workingDir;

  const tddExceptions = pickStringArray(source, "tddExceptions", warnings);
  if (tddExceptions !== undefined) result.tddExceptions = tddExceptions;

  const secretAllowlist = pickStringArray(source, "secretAllowlist", warnings);
  if (secretAllowlist !== undefined) result.secretAllowlist = secretAllowlist;

  const protectedBranches = pickStringArray(source, "protectedBranches", warnings);
  if (protectedBranches !== undefined) result.protectedBranches = protectedBranches;

  const actFlags = pickStringArray(source, "actFlags", warnings);
  if (actFlags !== undefined) result.actFlags = actFlags;

  const secretDetectionStrict = pickBoolean(source, "secretDetectionStrict", warnings);
  if (secretDetectionStrict !== undefined) result.secretDetectionStrict = secretDetectionStrict;

  const commitConvention = pickEnum(source, "commitConvention", COMMIT_CONVENTION_VALUES, warnings);
  if (commitConvention !== undefined) result.commitConvention = commitConvention;

  const checks = pickChecks(source, warnings);
  if (checks !== undefined) result.checks = checks;

  const setup = pickSetup(source, warnings);
  if (setup !== undefined) result.setup = setup;

  const commands = pickCommands(source, warnings);
  if (commands !== undefined) result.commands = commands;

  const sandbox = pickSandbox(source, warnings);
  if (sandbox !== undefined) result.sandbox = sandbox;

  const customChecks = pickCustomChecks(source, warnings);
  if (customChecks !== undefined) result.customChecks = customChecks;

  return { config: result, warnings };
}

export function loadConfig(repoPath: string): PreflightConfig {
  const configPath = path.join(repoPath, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return defaultConfig();
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const { config: validated, warnings } = validateConfig(parsed);
    for (const warning of warnings) {
      console.warn(`[preflight] Warning: ${configPath}: ${warning}`);
    }
    return mergeConfig(defaultConfig(), validated);
  } catch (err) {
    console.warn(`[preflight] Warning: failed to parse ${configPath}: ${(err as Error).message}`);
    return defaultConfig();
  }
}

export function defaultConfig(): PreflightConfig {
  return {
    checks: {
      gitState: true,
      lint: true,
      typecheck: true,
      test: true,
      audit: true,
      ciSimulation: false, // off by default — requires act installed
      commitConvention: true,
      secretDetection: true,
    },
    protectedBranches: ["main", "master"],
    commitConvention: "conventional",
    workingDir: ".",
    setup: {
      enabled: false,
    },
    actFlags: [...DEFAULT_ACT_FLAGS],
    commands: {},
    sandbox: {
      aptPackages: [],
      pipPackages: [],
    },
    customChecks: [],
  };
}

export function mergeConfig(
  baseConfig: PreflightConfig,
  overrideConfig: Partial<PreflightConfig>
): PreflightConfig {
  return {
    ...baseConfig,
    ...overrideConfig,
    checks: {
      ...baseConfig.checks,
      ...overrideConfig.checks,
    },
    setup: {
      ...baseConfig.setup,
      ...overrideConfig.setup,
    },
    commands: {
      ...baseConfig.commands,
      ...overrideConfig.commands,
    },
    sandbox: {
      ...baseConfig.sandbox,
      ...overrideConfig.sandbox,
      aptPackages: overrideConfig.sandbox?.aptPackages ?? baseConfig.sandbox?.aptPackages ?? [],
      pipPackages: overrideConfig.sandbox?.pipPackages ?? baseConfig.sandbox?.pipPackages ?? [],
    },
    customChecks: overrideConfig.customChecks ?? baseConfig.customChecks,
  };
}

// ---------------------------------------------------------------------------
// Field-level type guards and pickers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function pickString(source: Record<string, unknown>, key: string, warnings: string[]): string | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (isString(value)) return value;
  warnings.push(`${key}: expected a string, got ${describeType(value)}; ignoring this field`);
  return undefined;
}

function pickBoolean(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
  label: string = key
): boolean | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (isBoolean(value)) return value;
  warnings.push(`${label}: expected a boolean, got ${describeType(value)}; ignoring this field`);
  return undefined;
}

function pickStringArray(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
  label: string = key
): string[] | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (isStringArray(value)) return value;
  warnings.push(`${label}: expected an array of strings, got ${describeType(value)}; ignoring this field`);
  return undefined;
}

function pickEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  warnings: string[]
): T | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (isString(value) && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  warnings.push(
    `${key}: expected one of ${allowed.join(", ")}, got ${describeType(value)}; ignoring this field`
  );
  return undefined;
}

function pickChecks(
  source: Record<string, unknown>,
  warnings: string[]
): PreflightConfig["checks"] | undefined {
  if (!("checks" in source)) return undefined;
  const value = source.checks;
  if (!isPlainObject(value)) {
    warnings.push(`checks: expected an object, got ${describeType(value)}; ignoring this field`);
    return undefined;
  }

  const checks: NonNullable<PreflightConfig["checks"]> = {};

  for (const key of CHECK_TOGGLE_KEYS) {
    if (!(key in value)) continue;
    const toggle = value[key];
    if (isBoolean(toggle) || isPlainObject(toggle)) {
      checks[key] = toggle as CheckToggle;
    } else {
      warnings.push(`checks.${key}: expected a boolean or an object, got ${describeType(toggle)}; ignoring this field`);
    }
  }

  for (const key of CHECK_BOOLEAN_KEYS) {
    const bool = pickBoolean(value, key, warnings, `checks.${key}`);
    if (bool !== undefined) checks[key] = bool;
  }

  return checks;
}

function pickSetup(
  source: Record<string, unknown>,
  warnings: string[]
): PreflightConfig["setup"] | undefined {
  if (!("setup" in source)) return undefined;
  const value = source.setup;
  if (!isPlainObject(value)) {
    warnings.push(`setup: expected an object, got ${describeType(value)}; ignoring this field`);
    return undefined;
  }

  const setup: NonNullable<PreflightConfig["setup"]> = {};
  const enabled = pickBoolean(value, "enabled", warnings, "setup.enabled");
  if (enabled !== undefined) setup.enabled = enabled;
  return setup;
}

function pickCommands(
  source: Record<string, unknown>,
  warnings: string[]
): PreflightConfig["commands"] | undefined {
  if (!("commands" in source)) return undefined;
  const value = source.commands;
  if (!isPlainObject(value)) {
    warnings.push(`commands: expected an object, got ${describeType(value)}; ignoring this field`);
    return undefined;
  }

  const commands: NonNullable<PreflightConfig["commands"]> = {};
  for (const key of COMMAND_KEYS) {
    const arr = pickStringArray(value, key, warnings, `commands.${key}`);
    if (arr !== undefined) commands[key] = arr;
  }
  return commands;
}

function pickSandbox(
  source: Record<string, unknown>,
  warnings: string[]
): SandboxConfig | undefined {
  if (!("sandbox" in source)) return undefined;
  const value = source.sandbox;
  if (!isPlainObject(value)) {
    warnings.push(`sandbox: expected an object, got ${describeType(value)}; ignoring this field`);
    return undefined;
  }

  const sandbox: SandboxConfig = {};
  const aptPackages = pickStringArray(value, "aptPackages", warnings, "sandbox.aptPackages");
  if (aptPackages !== undefined) sandbox.aptPackages = aptPackages;
  const pipPackages = pickStringArray(value, "pipPackages", warnings, "sandbox.pipPackages");
  if (pipPackages !== undefined) sandbox.pipPackages = pipPackages;
  return sandbox;
}

function pickCustomChecks(
  source: Record<string, unknown>,
  warnings: string[]
): CustomCheck[] | undefined {
  if (!("customChecks" in source)) return undefined;
  const value = source.customChecks;
  if (!Array.isArray(value)) {
    warnings.push(`customChecks: expected an array, got ${describeType(value)}; ignoring this field`);
    return undefined;
  }

  const customChecks: CustomCheck[] = [];
  value.forEach((item: unknown, index: number) => {
    if (!isPlainObject(item)) {
      warnings.push(`customChecks[${index}]: expected an object, got ${describeType(item)}; dropping this entry`);
      return;
    }
    if (!isString(item.name) || !isString(item.command)) {
      warnings.push(`customChecks[${index}]: "name" and "command" must be strings; dropping this entry`);
      return;
    }

    const entry: CustomCheck = { name: item.name, command: item.command };
    if ("failOnError" in item) {
      if (isBoolean(item.failOnError)) {
        entry.failOnError = item.failOnError;
      } else {
        warnings.push(
          `customChecks[${index}].failOnError: expected a boolean, got ${describeType(item.failOnError)}; ignoring this field`
        );
      }
    }
    customChecks.push(entry);
  });

  return customChecks;
}
