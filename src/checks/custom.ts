import { CheckResult, PreflightConfig } from "../types.js";
import { CheckSetResult, runShellCheck } from "./shared.js";

export async function runCustomChecks(
  repoPath: string,
  config: PreflightConfig
): Promise<CheckSetResult> {
  const checks: CheckResult[] = [];
  const limitations: string[] = [];

  for (const customCheck of config.customChecks ?? []) {
    const result = await runShellCheck({
      repoPath,
      name: customCheck.name,
      kind: "custom",
      command: customCheck.command,
      weight: 0.1,
      failureMessage: `${customCheck.name} failed`,
      failureStatus: customCheck.failOnError === false ? "warn" : "fail",
    });

    if (result.check) {
      checks.push(result.check);
    }
    if (result.limitation) {
      limitations.push(result.limitation);
    }
  }

  return { checks, limitations };
}
