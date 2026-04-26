#!/usr/bin/env node
import { Command } from "commander";
import path from "path";
import { loadConfig } from "./config.js";
import { runPreflight } from "./runner.js";
import { runBatch } from "./batch.js";
import { runSandbox } from "./sandbox.js";
import { VERSION } from "./version.js";
import type { PreflightConfig } from "./types.js";

const program = new Command();

program
  .name("preflight")
  .description("CI preflight validation for AI agents")
  .version(VERSION);

program
  .command("run [repoPath]")
  .description("Run preflight checks on a repository")
  .option("--json", "Output raw JSON (default: pretty summary)")
  .option("--setup", "Enable conservative dependency/setup bootstrap before checks")
  .option("--ci-simulation", "Enable act-based CI simulation (requires act)")
  .option("--no-audit", "Skip dependency audit")
  .option("--no-secrets", "Skip secret detection")
  .action(async (repoPath: string | undefined, opts) => {
    const resolvedPath = path.resolve(repoPath ?? process.cwd());
    const config = loadConfig(resolvedPath);

    if (opts.setup) config.setup = { ...config.setup, enabled: true };
    if (opts.ciSimulation) config.checks = { ...config.checks, ciSimulation: true };
    if (opts.noAudit) config.checks = { ...config.checks, audit: false };
    if (opts.noSecrets) config.checks = { ...config.checks, secretDetection: false };

    const result = await runPreflight(resolvedPath, config);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ready ? 0 : 1);
    }

    const icon = result.ready ? "✅" : "❌";
    const conf = Math.round(result.confidence * 100);
    console.log(`\n${icon} preflight: ${result.ready ? "READY" : "NOT READY"} (confidence: ${conf}%)\n`);

    if (result.blockers.length > 0) {
      console.log("Blockers:");
      result.blockers.forEach((b) => console.log(`  ✗ ${b}`));
      console.log();
    }

    if (result.warnings.length > 0) {
      console.log("Warnings:");
      result.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
      console.log();
    }

    if (result.limitations.length > 0) {
      console.log("Limitations (not validated locally):");
      result.limitations.forEach((l) => console.log(`  ~ ${l}`));
      console.log();
    }

    console.log(`Checks: ${result.checks.length} | Duration: ${result.durationMs}ms`);
    process.exit(result.ready ? 0 : 1);
  });

program
  .command("batch [root]")
  .description("Run preflight across all Git repos in a directory (inspired by git-batch-cli)")
  .option("--only <pattern>", "Only include repos matching glob pattern (e.g. frost-*)")
  .option("--exclude <pattern>", "Exclude repos matching glob pattern")
  .option("--json", "Output raw JSON")
  .option("--setup", "Enable conservative dependency/setup bootstrap before checks")
  .option("--no-audit", "Skip dependency audit for all repos")
  .option("--no-secrets", "Skip secret detection for all repos")
  .action(async (root: string | undefined, opts) => {
    const resolvedRoot = path.resolve(root ?? process.cwd());
    const configOverride: Partial<PreflightConfig> = {};

    if (opts.setup) configOverride.setup = { enabled: true };
    if (opts.noAudit) configOverride.checks = { ...configOverride.checks, audit: false };
    if (opts.noSecrets) configOverride.checks = { ...configOverride.checks, secretDetection: false };

    const batchResult = await runBatch(
      resolvedRoot,
      { only: opts.only, exclude: opts.exclude },
      configOverride
    );

    if (opts.json) {
      console.log(JSON.stringify(batchResult, null, 2));
      process.exit(batchResult.notReady > 0 ? 1 : 0);
    }

    console.log(`\n📦 Batch preflight: ${resolvedRoot}`);
    console.log(`   ${batchResult.total} repos | ✅ ${batchResult.ready} ready | ❌ ${batchResult.notReady} not ready | ⚠ ${batchResult.skipped} skipped\n`);

    for (const { repo, result, error } of batchResult.results) {
      if (error) {
        console.log(`  ⚠ ${repo}: error — ${error}`);
        continue;
      }
      if (!result) continue;
      const icon = result.ready ? "✅" : "❌";
      const conf = Math.round(result.confidence * 100);
      const blockers = result.blockers.length > 0 ? ` [${result.blockers[0]}]` : "";
      console.log(`  ${icon} ${repo} (${conf}%)${blockers}`);
    }

    console.log();
    process.exit(batchResult.notReady > 0 ? 1 : 0);
  });

program
  .command("sandbox [repoPath]")
  .description("Run preflight inside the sandbox image")
  .option("--build", "Build the local sandbox image before starting")
  .option("--pull", "Pull the configured image before starting")
  .option("--print", "Print the docker command and exit")
  .option("--docker-socket", "Mount /var/run/docker.sock so act can talk to the host daemon")
  .option("--image <image>", "Override the image to run")
  .option("--json", "Output raw JSON from the preflight run")
  .option("--setup", "Enable conservative dependency/setup bootstrap before checks")
  .option("--ci-simulation", "Enable act-based CI simulation inside the container")
  .option("--no-audit", "Skip dependency audit")
  .option("--no-secrets", "Skip secret detection")
  .action(async (repoPath: string | undefined, opts) => {
    await runSandbox(repoPath, opts);
  });

program.parseAsync();
