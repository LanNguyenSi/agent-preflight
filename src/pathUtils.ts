import os from "os";
import path from "path";

/**
 * Expands a leading `~/` to `os.homedir()`. Shared by both log-directory
 * sources (task 2e8bcc7e) so a `~/`-prefixed value behaves identically
 * whether it comes from `.preflight.json`'s `logDir` (see runner.ts's
 * `configuredLogDir`) or the `PREFLIGHT_LOG_DIR` environment variable (see
 * `checks/shared.ts`'s `defaultLogDir`). Any other value (already
 * absolute, relative without a tilde, empty, or a bare `~` with no
 * trailing slash) passes through unchanged.
 *
 * Lives in its own module, not in either `runner.ts` or `checks/shared.ts`,
 * because `runner.ts` imports from `checks/shared.ts` (for
 * `ensureProjectSetup`, `defaultLogDir`, etc.): putting this helper in
 * `checks/shared.ts` and importing it back from `runner.ts` would still
 * work, but putting it in `runner.ts` and importing it from
 * `checks/shared.ts` would create a cycle.
 */
export function expandLeadingTilde(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
