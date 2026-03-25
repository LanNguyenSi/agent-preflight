import fs from "fs";
import path from "path";
import { PreflightConfig, PreflightResult } from "./types.js";
import { loadConfig } from "./config.js";
import { runPreflight } from "./runner.js";

export interface BatchOptions {
  only?: string; // glob pattern, e.g. "frost-*"
  exclude?: string; // glob pattern
  maxConcurrent?: number;
}

export interface BatchResult {
  root: string;
  total: number;
  ready: number;
  notReady: number;
  skipped: number;
  results: Array<{
    repo: string;
    path: string;
    result: PreflightResult | null;
    error?: string;
  }>;
}

export function discoverRepos(root: string, opts: BatchOptions = {}): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(root, e.name))
    .filter((p) => fs.existsSync(path.join(p, ".git")))
    .filter((p) => {
      const name = path.basename(p);
      if (opts.only && !matchGlob(name, opts.only)) return false;
      if (opts.exclude && matchGlob(name, opts.exclude)) return false;
      return true;
    });
}

export async function runBatch(
  root: string,
  opts: BatchOptions = {},
  configOverride?: Partial<PreflightConfig>
): Promise<BatchResult> {
  const repos = discoverRepos(root, opts);
  const results: BatchResult["results"] = [];

  // Run sequentially to avoid resource contention (act uses Docker)
  for (const repoPath of repos) {
    const name = path.basename(repoPath);
    try {
      const config = { ...loadConfig(repoPath), ...configOverride };
      const result = await runPreflight(repoPath, config);
      results.push({ repo: name, path: repoPath, result });
    } catch (err) {
      results.push({
        repo: name,
        path: repoPath,
        result: null,
        error: (err as Error).message,
      });
    }
  }

  const ready = results.filter((r) => r.result?.ready === true).length;
  const notReady = results.filter((r) => r.result?.ready === false).length;
  const skipped = results.filter((r) => r.result === null).length;

  return { root, total: repos.length, ready, notReady, skipped, results };
}

function matchGlob(name: string, pattern: string): boolean {
  // Simple glob: support * wildcard
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return regex.test(name);
}
