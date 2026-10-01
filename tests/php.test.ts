import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runLintChecks } from "../src/checks/lint.js";
import { runTypecheckChecks } from "../src/checks/typecheck.js";
import { runTestChecks } from "../src/checks/test.js";
import { runPreflight } from "../src/runner.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

interface Call { tool: string; cwd: string; args: string[] }

function fixture(options: { binDir?: string; git?: boolean; workingDir?: string; repoName?: string } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-php-"));
  tempDirs.push(outer);
  const repo = path.join(outer, options.repoName ?? "repo");
  const target = path.join(repo, options.workingDir ?? ".");
  const callsPath = path.join(outer, "calls.jsonl");
  fs.mkdirSync(target, { recursive: true });
  if (options.git !== false) execFileSync("git", ["init", "-q", repo]);
  const binDir = options.binDir ?? "vendor/bin";
  const composer = (extra: Record<string, unknown> = {}) => fs.writeFileSync(
    path.join(target, "composer.json"),
    JSON.stringify({ ...(options.binDir === undefined ? {} : { config: { "bin-dir": binDir } }), ...extra })
  );
  composer();
  const writeTool = (tool: string, directory = path.resolve(target, binDir), exitCode = 0) => {
    fs.mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, tool);
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ tool: ${JSON.stringify(tool)}, cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
process.exit(${exitCode});
`, { mode: 0o755 });
    return executable;
  };
  const configFile = (name: string, directory = target) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, "fixture config\n");
    return fs.realpathSync(file);
  };
  const calls = (): Call[] => fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
    : [];
  return { outer, repo, target, composer, writeTool, configFile, calls, logDir: path.join(outer, "logs") };
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const configuredTools = [
  { tool: "phpstan", run: runTypecheckChecks, config: "phpstan.neon", flag: "--configuration=", args: ["analyse"] },
  { tool: "phpcs", run: runLintChecks, config: "phpcs.xml", flag: "--standard=", args: [] },
];

describe("PHP tool discovery", () => {
  it.each(configuredTools)("uses the default bin directory and explicit config for $tool", async ({ tool, run, config, flag, args }) => {
    const f = fixture();
    f.writeTool(tool);
    const configPath = f.configFile(config);

    const result = await run(f.target, { logDir: f.logDir });

    expect(result.checks.map(c => [c.name, c.status])).toEqual([[tool, "pass"]]);
    expect(result.limitations).toEqual([]);
    expect(f.calls()).toEqual([{ tool, cwd: fs.realpathSync(f.target), args: [...args, flag + configPath] }]);
  });

  it.each(configuredTools)("quotes a custom bin directory and config path for $tool", async ({ tool, run, config, flag, args }) => {
    const f = fixture({ binDir: "tools' space;$(touch injected)", repoName: "repo' space;$(touch escaped) " });
    f.writeTool(tool);
    const configPath = f.configFile(config);

    const result = await run(f.target, { logDir: f.logDir });

    expect(result.checks.map(c => c.status)).toEqual(["pass"]);
    expect(f.calls()).toEqual([{ tool, cwd: fs.realpathSync(f.target), args: [...args, flag + configPath] }]);
    expect(fs.existsSync(path.join(f.target, "injected"))).toBe(false);
    expect(fs.existsSync(path.join(f.target, "escaped"))).toBe(false);
  });

  it.each([
    { tool: "pint", run: runLintChecks, args: ["--test"] },
    { tool: "psalm", run: runTypecheckChecks, args: ["--no-progress"] },
  ])("preserves $tool arguments with default and custom bin directories", async ({ tool, run, args }) => {
    for (const binDir of [undefined, "tools with spaces'"]) {
      const f = fixture({ binDir });
      f.writeTool(tool);
      const result = await run(f.target, { logDir: f.logDir });
      expect(result.checks.map(c => [c.name, c.status])).toEqual([[tool, "pass"]]);
      expect(f.calls()).toEqual([{ tool, cwd: fs.realpathSync(f.target), args }]);
    }
  });

  it("supports an absolute Composer bin directory", async () => {
    const f = fixture();
    const absoluteBin = path.join(f.outer, "shared tools");
    f.composer({ config: { "bin-dir": absoluteBin } });
    f.writeTool("pint", absoluteBin);
    const result = await runLintChecks(f.target, { logDir: f.logDir });
    expect(result.checks.map(c => c.status)).toEqual(["pass"]);
    expect(f.calls().map(c => c.tool)).toEqual(["pint"]);
  });

  it.each([null, 42, "", "   "])("uses the default bin directory for invalid bin-dir %j", async binDir => {
    const f = fixture();
    f.composer({ config: { "bin-dir": binDir } });
    f.writeTool("pint");
    const result = await runLintChecks(f.target, { logDir: f.logDir });
    expect(result.checks.map(c => c.status)).toEqual(["pass"]);
  });

  it("keeps a missing declared PHP tool visible as a limitation", async () => {
    const f = fixture({ binDir: "missing tools" });
    f.composer({ config: { "bin-dir": "missing tools" }, "require-dev": { "phpstan/phpstan": "*" } });
    f.configFile("phpstan.neon");
    const result = await runTypecheckChecks(f.target, { logDir: f.logDir });
    expect(result.checks).toEqual([]);
    expect(result.limitations).toContain("phpstan not installed; PHP typecheck skipped");
  });
});

describe("PHP configuration discovery", () => {
  it.each(configuredTools)("selects the nearest $tool config, including the target directory", async ({ tool, run, config, flag, args }) => {
    const f = fixture({ workingDir: "packages/service" });
    f.writeTool(tool);
    f.configFile(config, f.repo);
    const parentConfig = f.configFile(config + ".dist", path.dirname(f.target));
    await run(f.target, { logDir: f.logDir });
    expect(f.calls()[0].args).toEqual([...args, flag + parentConfig]);

    const targetConfig = f.configFile(config);
    await run(f.target, { logDir: f.logDir });
    expect(f.calls()[1].args).toEqual([...args, flag + targetConfig]);
  });

  it.each([
    ...["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"].map(config => ({ ...configuredTools[0], config })),
    ...[".phpcs.xml", ".phpcs.xml.dist", "phpcs.xml", "phpcs.xml.dist"].map(config => ({ ...configuredTools[1], config })),
  ])("finds $config at the repository root", async ({ tool, run, config, flag, args }) => {
    const f = fixture({ workingDir: "packages/service" });
    f.writeTool(tool);
    const rootConfig = f.configFile(config, f.repo);
    const result = await run(f.target, { logDir: f.logDir });
    expect(result.checks.map(c => c.status)).toEqual(["pass"]);
    expect(f.calls()[0].args).toEqual([...args, flag + rootConfig]);
  });

  it.each([
    { ...configuredTools[0], names: ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"] },
    { ...configuredTools[1], names: [".phpcs.xml", "phpcs.xml", ".phpcs.xml.dist", "phpcs.xml.dist"] },
  ])("uses $tool filename precedence within one directory", async ({ tool, run, names, flag, args }) => {
    const f = fixture();
    f.writeTool(tool);
    const configs = names.map(name => f.configFile(name));
    for (const [index, configPath] of configs.entries()) {
      expect((await run(f.target, { logDir: f.logDir })).checks[0].status).toBe("pass");
      expect(f.calls()[index].args).toEqual([...args, flag + configPath]);
      fs.rmSync(configPath);
    }
  });

  it.each(configuredTools)("does not use $tool configuration above the Git root", async ({ tool, run, config }) => {
    const f = fixture({ workingDir: "service" });
    f.writeTool(tool);
    f.configFile(config, f.outer);
    const result = await run(f.target, { logDir: f.logDir });
    expect(f.calls()).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(result.limitations.join(" ")).toContain("config found within the repository");
    expect(result.limitations.join(" ")).toContain("configure commands.");
  });

  it.each(configuredTools)("limits non-Git $tool discovery to the target directory", async ({ tool, run, config }) => {
    const f = fixture({ git: false, workingDir: "service" });
    f.writeTool(tool);
    f.configFile(config, f.repo);
    const result = await run(f.target, { logDir: f.logDir });
    expect(result.checks).toEqual([]);
    expect(f.calls()).toEqual([]);
    f.configFile(config);
    expect((await run(f.target, { logDir: f.logDir })).checks[0].status).toBe("pass");
  });

  it("honors workingDir for both tool paths and command cwd while finding root configs", async () => {
    const f = fixture({ workingDir: "app", binDir: "../tools" });
    f.writeTool("phpcs");
    f.writeTool("phpstan");
    const phpcsConfig = f.configFile("phpcs.xml", f.repo);
    const phpstanConfig = f.configFile("phpstan.neon", f.repo);

    const result = await runPreflight(f.repo, {
      workingDir: "app", logDir: f.logDir,
      checks: { gitState: false, lint: true, typecheck: true, test: false, audit: false,
        secretDetection: false, commitConvention: false, ciSimulation: false, tdd: false },
    });

    expect(result.checks.map(c => [c.name, c.status])).toEqual([["phpcs", "pass"], ["phpstan", "pass"]]);
    expect(f.calls()).toEqual([
      { tool: "phpcs", cwd: fs.realpathSync(f.target), args: ["--standard=" + phpcsConfig] },
      { tool: "phpstan", cwd: fs.realpathSync(f.target), args: ["analyse", "--configuration=" + phpstanConfig] },
    ]);
  });
});

describe("explicit PHP commands", () => {
  it.each([undefined, "custom tools"])("does not run the PHPUnit sentinel automatically (bin-dir: %s)", async binDir => {
    const f = fixture({ binDir });
    f.writeTool("phpunit");
    const result = await runTestChecks(f.target, { logDir: f.logDir });
    expect(f.calls()).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(result.limitations.join(" ")).toContain("commands.test");
    expect(result.limitations.join(" ")).toContain("bare PHPUnit is not run automatically");
  });

  it("runs explicitly configured PHPUnit with its requested scope", async () => {
    const f = fixture();
    f.writeTool("phpunit");
    const result = await runTestChecks(f.target, {
      commands: { test: ["vendor/bin/phpunit --testsuite unit"] }, logDir: f.logDir,
    });
    expect(result.checks.map(c => c.status)).toEqual(["pass"]);
    expect(f.calls()).toEqual([{ tool: "phpunit", cwd: fs.realpathSync(f.target), args: ["--testsuite", "unit"] }]);
  });

  it("preserves Composer scripts and gives configured commands precedence", async () => {
    const f = fixture();
    f.composer({ scripts: { lint: "phpcs", test: ["phpunit --testsuite unit"] } });
    const bin = path.join(f.outer, "bin");
    f.writeTool("composer", bin);
    f.writeTool("pint");
    f.writeTool("phpunit");
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    expect((await runLintChecks(f.target, { logDir: f.logDir })).checks[0].name).toBe("composer-lint");
    expect((await runTestChecks(f.target, { logDir: f.logDir })).checks[0].name).toBe("composer-test");
    expect(f.calls().map(c => [c.tool, ...c.args])).toEqual([["composer", "run", "lint"], ["composer", "run", "test"]]);

    const explicit = { commands: { lint: ["vendor/bin/pint --test"], typecheck: ["vendor/bin/pint --test"], test: ["vendor/bin/phpunit --testsuite unit"] }, logDir: f.logDir };
    await runLintChecks(f.target, explicit);
    await runTypecheckChecks(f.target, explicit);
    await runTestChecks(f.target, explicit);
    expect(f.calls().slice(2).map(c => c.tool)).toEqual(["pint", "pint", "phpunit"]);
  });

  it("retains nonzero exit failures for explicit PHP commands", async () => {
    const f = fixture();
    f.writeTool("phpunit", undefined, 1);
    const result = await runTestChecks(f.target, { commands: { test: ["vendor/bin/phpunit --testsuite unit"] }, logDir: f.logDir });
    expect(result.checks.map(c => c.status)).toEqual(["fail"]);
    expect(result.limitations).toEqual([]);
  });
});
