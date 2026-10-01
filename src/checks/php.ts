import { execa } from "execa";
import fs from "fs";
import path from "path";
import type { ProjectContext } from "./shared.js";

export function composerBinPath(context: ProjectContext, tool: string): string {
  const configured = context.composerJson?.config?.["bin-dir"];
  const binDir = typeof configured === "string" && configured.trim() ? configured : "vendor/bin";
  return path.resolve(context.repoPath, binDir, tool);
}

export function quotePhpArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const CONFIG_NAMES = {
  phpstan: ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"],
  phpcs: [".phpcs.xml", "phpcs.xml", ".phpcs.xml.dist", "phpcs.xml.dist"],
};

export async function findPhpConfig(
  targetPath: string,
  tool: keyof typeof CONFIG_NAMES
): Promise<string | undefined> {
  const target = fs.realpathSync(targetPath);
  let root = target;
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: target });
    const gitRoot = fs.realpathSync(stdout);
    const relative = path.relative(gitRoot, target);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      root = gitRoot;
    }
  } catch {
    // Without a Git boundary, only the target directory is eligible.
  }

  for (let directory = target; ; directory = path.dirname(directory)) {
    for (const name of CONFIG_NAMES[tool]) {
      const candidate = path.join(directory, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // A missing or unreadable candidate does not prevent trying the next one.
      }
    }
    if (directory === root) return undefined;
  }
}
