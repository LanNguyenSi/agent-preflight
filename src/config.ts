import fs from "fs";
import path from "path";
import { PreflightConfig } from "./types.js";

const CONFIG_FILENAME = ".preflight.json";

export function loadConfig(repoPath: string): PreflightConfig {
  const configPath = path.join(repoPath, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return defaultConfig();
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PreflightConfig>;
    return { ...defaultConfig(), ...parsed };
  } catch (err) {
    console.warn(`[preflight] Warning: failed to parse ${configPath}: ${(err as Error).message}`);
    return defaultConfig();
  }
}

export function defaultConfig(): PreflightConfig {
  return {
    checks: {
      lint: true,
      typecheck: true,
      test: true,
      audit: true,
      ciSimulation: false, // off by default — requires act installed
      commitConvention: true,
      secretDetection: true,
    },
    commitConvention: "conventional",
    actFlags: [],
    customChecks: [],
  };
}
