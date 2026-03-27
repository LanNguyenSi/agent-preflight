import fs from "fs";
import path from "path";
import { PreflightConfig } from "./types.js";

const CONFIG_FILENAME = ".preflight.json";
const DEFAULT_ACT_FLAGS = ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"];

export function loadConfig(repoPath: string): PreflightConfig {
  const configPath = path.join(repoPath, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return defaultConfig();
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PreflightConfig>;
    return mergeConfig(defaultConfig(), parsed);
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
    actFlags: [...DEFAULT_ACT_FLAGS],
    commands: {},
    sandbox: {
      aptPackages: [],
      pipPackages: [],
    },
    customChecks: [],
  };
}

function mergeConfig(
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
