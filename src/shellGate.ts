import { CheckResult, ConfiguredCheckKind, PreflightConfig } from "./types.js";

/**
 * Server environment variable that lets the MCP surface execute shell
 * commands defined by the target repo's config. Only the exact value "1"
 * enables it.
 */
export const MCP_ALLOW_SHELL_ENV = "PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS";

export const SHELL_SKIPPED_MESSAGE =
  "Skipped: shell commands from the repo config are disabled on the MCP surface; set PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1 in the MCP server environment to enable them";

const CONFIGURED_KINDS: ConfiguredCheckKind[] = ["lint", "typecheck", "test", "audit"];

export function mcpShellExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MCP_ALLOW_SHELL_ENV] === "1";
}

function skippedResult(name: string, kind: CheckResult["kind"]): CheckResult {
  return {
    name,
    kind,
    status: "skip",
    message: SHELL_SKIPPED_MESSAGE,
    durationMs: 0,
    confidenceContribution: 0,
  };
}

/**
 * Returns a copy of `config` without the shell commands the repo config
 * defines (customChecks and commands.lint/typecheck/test/audit), plus one
 * skipped result per removed entry. A kind whose configured commands were
 * removed is also switched off (`checks.<kind>: false`), because without the
 * configured commands that kind would fall back to autodetection and run the
 * repo's own script (for example `npm run lint`) in place of them. The input
 * is never mutated.
 */
export function stripShellExecution(config: PreflightConfig): {
  config: PreflightConfig;
  skipped: CheckResult[];
  limitations: string[];
} {
  const skipped: CheckResult[] = [];

  const customChecks = Array.isArray(config.customChecks) ? config.customChecks : [];
  for (const customCheck of customChecks) {
    skipped.push(skippedResult(customCheck.name, "custom"));
  }

  const stripped: PreflightConfig = { ...config, customChecks: [] };
  if (config.commands !== undefined) {
    const commands = { ...config.commands };
    const disabledKinds: ConfiguredCheckKind[] = [];
    for (const kind of CONFIGURED_KINDS) {
      const entries = commands[kind];
      if (entries === undefined) continue;
      delete commands[kind];
      // An empty array already means "autodetect", so nothing was replaced.
      if (!Array.isArray(entries) || entries.length > 0) disabledKinds.push(kind);
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        const name = typeof entry === "string" ? undefined : entry?.name;
        skipped.push(skippedResult(name ?? `${kind}:${index + 1}`, kind));
      });
    }
    stripped.commands = commands;
    if (disabledKinds.length > 0) {
      const checks = { ...config.checks };
      for (const kind of disabledKinds) checks[kind] = false;
      stripped.checks = checks;
    }
  }

  const limitations =
    skipped.length > 0
      ? [
          `MCP: ${skipped.length} shell command(s) from the repo config were not run (${MCP_ALLOW_SHELL_ENV} is not "1")`,
        ]
      : [];
  return { config: stripped, skipped, limitations };
}
