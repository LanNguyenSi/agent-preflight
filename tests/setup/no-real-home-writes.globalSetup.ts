/**
 * Structural guard for the `ShellCheckOptions.logDir` docblock contract in
 * src/checks/shared.ts: "Tests MUST override this to a temp directory so
 * they never write into the real home directory." Individual test files are
 * expected to pass an explicit `logDir` to every `runShellCheck`/
 * `runPreflight` call that can fail, but that discipline is easy to forget
 * on a new test; this guard catches a regression across the WHOLE suite,
 * not just the file it was added to.
 *
 * Why a Vitest `globalSetup` (this file) rather than the two alternatives
 * considered:
 *
 * - A global `os.homedir()` stub in a per-file `setupFiles` entry would run
 *   inside every worker for every test file, which conflicts with
 *   `tests/shared-fail-log.test.ts`'s own dedicated test ("resolves under
 *   os.homedir()/.agent-preflight/logs when not overridden"): that test
 *   deliberately asserts on the *real* default-logDir resolution behavior
 *   by mocking `os.homedir()` itself; a suite-wide stub would fight that
 *   test's own `vi.spyOn`/`vi.restoreAllMocks()` lifecycle (restoring past
 *   the local mock could land back on the global stub instead of the real
 *   implementation, or vice versa, depending on mock stacking order).
 * - A single "pin test" that snapshots the directory before/after its own
 *   file only catches violations introduced in that one file, and is not
 *   reliable ordering-wise: this repo runs with `fileParallelism: false`,
 *   but Vitest does not guarantee any test *file* runs last, so a pin test
 *   living in one file cannot see writes made by files that run after it.
 *
 * `globalSetup` sidesteps both problems: it runs exactly once in the main
 * process before any test file starts and its returned teardown runs
 * exactly once after every test file (across every worker) has finished, so
 * it observes the true before/after state of the real log directory for the
 * entire run regardless of file ordering or parallelism, without touching
 * `os.homedir()` at all (so the dedicated mock-based test above is
 * unaffected).
 */
import fs from "fs";
import os from "os";
import path from "path";

const REAL_LOG_DIR = path.join(os.homedir(), ".agent-preflight", "logs");

function snapshot(): Set<string> {
  try {
    return new Set(fs.readdirSync(REAL_LOG_DIR));
  } catch {
    // Directory may not exist yet (e.g. a machine that never ran the real
    // `preflight` CLI); that's an empty snapshot, not an error.
    return new Set();
  }
}

export default function setup(): () => void {
  const before = snapshot();

  return function teardown(): void {
    const after = snapshot();
    const newFiles = [...after].filter((name) => !before.has(name));

    if (newFiles.length > 0) {
      const message =
        `${newFiles.length} file(s) were written into the REAL ${REAL_LOG_DIR} ` +
        `during this test run: ${newFiles.join(", ")}. Every runShellCheck()/` +
        `runPreflight() call in tests MUST pass an explicit logDir pointing at a ` +
        `temp directory (see the ShellCheckOptions.logDir docblock in ` +
        `src/checks/shared.ts). Find the offending call by grepping the test ` +
        `files touched in this change for runShellCheck( / runPreflight( without ` +
        `a logDir in the same config/options object.`;

      // Vitest v4 logs a globalSetup teardown rejection ("error during
      // close") but does NOT turn it into a non-zero process exit code by
      // itself (verified empirically: a thrown-only version of this guard
      // left `npx vitest run` exiting 0 even after printing the error).
      // Setting `process.exitCode` directly is what actually fails the run,
      // since Vitest's own `ctx.exit()` (the non-watch, non-force path used
      // by `vitest run`) lets the process exit naturally rather than calling
      // `process.exit()` itself, so Node applies whatever `process.exitCode`
      // was last set to. The `throw` is kept too, purely so the "error
      // during close" trace with this message still surfaces in the log for
      // a human debugging a red run.
      process.exitCode = 1;
      throw new Error(message);
    }
  };
}
