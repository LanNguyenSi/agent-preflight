import { commandConfigurationError } from "./config.js";
import { CheckResult, ConfiguredCheckKind, PreflightConfig } from "./types.js";

/**
 * Server environment variable that lets the MCP surface execute shell
 * commands defined by the target repo's config. Only the exact value "1"
 * enables it.
 */
export const MCP_ALLOW_SHELL_ENV = "PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS";

export const SHELL_SKIPPED_MESSAGE =
  "Skipped: shell commands from the repo config are disabled on the MCP surface; set PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1 in the MCP server environment to enable them";

export const CI_SIMULATION_SKIPPED_MESSAGE =
  "Skipped: CI simulation runs act with flags and an .actrc taken from the repo, so it is disabled on the MCP surface; set PREFLIGHT_MCP_ALLOW_CUSTOM_CHECKS=1 in the MCP server environment to enable it";

const CONFIGURED_KINDS: ConfiguredCheckKind[] = ["lint", "typecheck", "test", "audit"];

export function mcpShellExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MCP_ALLOW_SHELL_ENV] === "1";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skippedResult(
  name: string,
  kind: CheckResult["kind"],
  message: string = SHELL_SKIPPED_MESSAGE
): CheckResult {
  return {
    name,
    kind,
    status: "skip",
    message,
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
 * is never mutated. A malformed `commands` value (see
 * `commandConfigurationError`) is not removed: it stays so the runners report
 * it as a `<kind>:configuration` failure and nothing executes.
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
  // Only a plain-object `commands` can carry runnable entries. Any other value
  // (null, a number, an array) stays as is: the check runners reject it as a
  // configuration error before executing anything, whereas a copied `{}` would
  // let every kind fall back to autodetection.
  if (isPlainObject(config.commands)) {
    const commands = { ...config.commands };
    const disabledKinds: ConfiguredCheckKind[] = [];
    for (const kind of CONFIGURED_KINDS) {
      const entries = commands[kind];
      if (entries === undefined) continue;
      // A malformed override (wrong type, malformed entry, or an unrecognized
      // key anywhere in `commands`) stays in the copy: the check runners
      // reject it as a `<kind>:configuration` failure before executing
      // anything, exactly like the CLI. Removing it would let readiness pass.
      if (commandConfigurationError(config.commands, kind)) continue;
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

  const shellSkipped = skipped.length;
  const limitations =
    shellSkipped > 0
      ? [
          `MCP: ${shellSkipped} shell command(s) from the repo config were not run (${MCP_ALLOW_SHELL_ENV} is not "1")`,
        ]
      : [];

  // CI simulation runs `act` with repo-supplied `actFlags` (a later
  // `--dryrun=false` would override the leading `--dryrun`) and act also reads
  // an `.actrc` from the repo, so with the gate closed it is not run at all.
  // Dropping only `actFlags` would leave the `.actrc` path open.
  if (config.checks?.ciSimulation === true) {
    skipped.push(skippedResult("act-dry-run", "ci-simulation", CI_SIMULATION_SKIPPED_MESSAGE));
    limitations.push(
      `MCP: CI simulation was not run (${MCP_ALLOW_SHELL_ENV} is not "1"); act would take its flags from the repo config`
    );
    stripped.checks = { ...stripped.checks, ciSimulation: false };
    delete stripped.actFlags;
  }
  return { config: stripped, skipped, limitations };
}
