import { execa } from "execa";
import fs from "fs";
import path from "path";
import { CheckResult } from "../types.js";

interface CheckSetResult {
  checks: CheckResult[];
  limitations: string[];
}

export async function runLintChecks(repoPath: string): Promise<CheckSetResult> {
  const checks: CheckResult[] = [];
  const limitations: string[] = [];
  const pkg = readPackageJson(repoPath);

  // TypeScript/JavaScript: eslint
  if (pkg?.devDependencies?.eslint || pkg?.dependencies?.eslint) {
    checks.push(await runCommand("eslint", ["npx", "eslint", "src", "--ext", ".ts,.js", "--format", "json"], repoPath, "lint", 0.15));
  }

  // Python: ruff
  if (fs.existsSync(path.join(repoPath, "pyproject.toml")) || fs.existsSync(path.join(repoPath, "setup.py"))) {
    if (await commandExists("ruff")) {
      checks.push(await runCommand("ruff", ["ruff", "check", "src/", "tests/"], repoPath, "lint", 0.15));
    } else {
      limitations.push("ruff not installed; Python lint check skipped");
    }
  }

  if (checks.length === 0) {
    limitations.push("No supported linter found (eslint, ruff); lint check skipped");
  }

  return { checks, limitations };
}

async function runCommand(name: string, args: string[], cwd: string, kind: CheckResult["kind"], weight: number): Promise<CheckResult> {
  const start = Date.now();
  try {
    await execa(args[0], args.slice(1), { cwd, reject: false, all: true });
    return { name, kind, status: "pass", durationMs: Date.now() - start, confidenceContribution: weight };
  } catch (err: any) {
    return {
      name,
      kind,
      status: err.exitCode === 0 ? "pass" : "fail",
      message: `${name} failed`,
      details: err.all?.split("\n").slice(0, 10),
      durationMs: Date.now() - start,
      confidenceContribution: weight,
    };
  }
}

function readPackageJson(repoPath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execa("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}
