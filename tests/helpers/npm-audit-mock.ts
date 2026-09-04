import { vi, type MockInstance } from "vitest";
import { npmAuditRunner, type NpmAuditRunResult } from "../../src/checks/audit.js";

/**
 * Installer for the `npmAuditRunner.run` test seam (see
 * src/checks/audit.ts). Every integration/contract test that exercises
 * `runPreflight` with the npm audit check enabled must install this in
 * `beforeEach` and call the returned restore function in `afterEach`, so
 * the suite never reaches the live npm registry.
 *
 * Defaults to a clean result (exit 0, zero critical/high vulnerabilities);
 * pass a partial `NpmAuditRunResult` to simulate a different outcome for a
 * specific test.
 */
export function mockNpmAudit(
  overrides: Partial<NpmAuditRunResult> = {}
): () => void {
  const result: NpmAuditRunResult = {
    exitCode: 0,
    stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
    stderr: "",
    timedOut: false,
    ...overrides,
  };

  const spy: MockInstance = vi.spyOn(npmAuditRunner, "run").mockResolvedValue(result);

  return () => spy.mockRestore();
}

/** Convenience wrapper: installs a clean (pass) npm audit result. */
export function mockNpmAuditClean(): () => void {
  return mockNpmAudit();
}
