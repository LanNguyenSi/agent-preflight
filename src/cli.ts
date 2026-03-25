#!/usr/bin/env node
import { Command } from "commander";
import path from "path";
import { loadConfig } from "./config.js";
import { runPreflight } from "./runner.js";

const program = new Command();

program
  .name("preflight")
  .description("CI preflight validation for AI agents")
  .version("0.1.0");

program
  .command("run [repoPath]")
  .description("Run preflight checks on a repository")
  .option("--json", "Output raw JSON (default: pretty summary)")
  .option("--ci-simulation", "Enable act-based CI simulation (requires act)")
  .option("--no-audit", "Skip dependency audit")
  .option("--no-secrets", "Skip secret detection")
  .action(async (repoPath: string | undefined, opts) => {
    const resolvedPath = path.resolve(repoPath ?? process.cwd());
    const config = loadConfig(resolvedPath);

    if (opts.ciSimulation) config.checks = { ...config.checks, ciSimulation: true };
    if (opts.noAudit) config.checks = { ...config.checks, audit: false };
    if (opts.noSecrets) config.checks = { ...config.checks, secretDetection: false };

    const result = await runPreflight(resolvedPath, config);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ready ? 0 : 1);
    }

    // Pretty summary
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

program.parseAsync();
