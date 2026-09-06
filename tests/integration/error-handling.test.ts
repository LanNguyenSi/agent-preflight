import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPreflight } from '../../src/runner.js';
import { loadConfig } from '../../src/config.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { mockNpmAuditClean } from '../helpers/npm-audit-mock.js';

describe('Error Handling Integration Tests', () => {
  // Several runPreflight() calls below leave `audit` at its default (on) or
  // set it explicitly to `true`, so without this the suite would reach the
  // live npm registry. Installed/restored around every test (see
  // src/checks/audit.ts's npmAuditRunner test seam).
  let restoreNpmAudit: () => void;
  beforeEach(() => {
    restoreNpmAudit = mockNpmAuditClean();
  });
  afterEach(() => {
    restoreNpmAudit();
  });

  it('should handle missing repository path gracefully', async () => {
    const nonExistentPath = '/tmp/does-not-exist-' + Date.now();
    const config = {
      checks: {
        lint: false,
        typecheck: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    };

    // Runner degrades gracefully rather than throwing on non-existent path
    const result = await runPreflight(nonExistentPath, config);
    expect(result).toBeDefined();
    expect(typeof result.ready).toBe('boolean');
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('should handle empty configuration gracefully', async () => {
    const config = {};
    const result = await runPreflight('.', config);

    // Should still return valid result structure
    expect(result).toBeDefined();
    expect(result.checks).toBeInstanceOf(Array);
  }, 60000);

  it('should handle invalid .preflight.json gracefully', async () => {
    // loadConfig should handle malformed JSON
    const invalidPath = path.join(__dirname, '../fixtures/invalid-config');

    // If config file doesn't exist or is invalid, should return defaults
    const config = await loadConfig(invalidPath);
    expect(config).toBeDefined();
    expect(config.checks).toBeDefined();
  });

  it('should handle repositories without package.json', { timeout: 5000 }, async () => {
    // 5000ms budget: a regression toward the shared-/tmp cause below (or
    // any other walk of an unbounded tree) fails loudly instead of racing
    // back up to the 30s per-test default.
    const config = {
      checks: {
        audit: true, // npm audit requires package.json
      },
    };

    // The case used to point runPreflight() at the shared, unfiltered
    // `/tmp` while leaving every other checks.* toggle at its default
    // (on): secrets.ts's scanDir() walks the whole target tree (only a
    // per-file 2 MiB cap and a fixed SKIP_DIRS list, no cap on the tree
    // itself), so the secret scan alone raced the 30s per-test timeout
    // against everything else under /tmp, not anything under test. A
    // fresh, empty mkdtemp directory has no package.json (preserving the
    // case's intent) and nothing for secretDetection (or any other
    // default-on check) to walk.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-no-pkg-json-'));
    try {
      const result = await runPreflight(emptyDir, config);
      expect(result).toBeDefined();

      // With no package.json, hasNodeProject() is false, so audit.ts never
      // reaches a node-specific branch and falls through to its final
      // catch-all: no audit check is emitted at all, and the skip reason
      // is surfaced only as a limitation string.
      const auditChecks = result.checks.filter((c) =>
        c.name.toLowerCase().includes('audit')
      );
      expect(auditChecks).toHaveLength(0);
      expect(result.limitations).toContain(
        'No supported audit command found; audit check skipped'
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should handle repositories without tsconfig.json', { timeout: 5000 }, async () => {
    // Same cause and fix as the no-package.json case above; 5000ms budget
    // for the same reason.
    const config = {
      checks: {
        typecheck: true, // TypeScript check requires tsconfig.json
      },
    };

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-no-tsconfig-'));
    try {
      // A minimal package.json makes hasNodeProject() true so typecheck.ts
      // takes its "has a node project, but no tsconfig.json" branch
      // (src/checks/typecheck.ts) instead of falling through to the
      // no-node-project catch-all; it pushes a limitation and never spawns
      // tsc, so this stays in the milliseconds.
      fs.writeFileSync(
        path.join(emptyDir, 'package.json'),
        JSON.stringify({ name: 'preflight-no-tsconfig-fixture', version: '0.0.0' })
      );

      const result = await runPreflight(emptyDir, config);
      expect(result).toBeDefined();

      const typecheckChecks = result.checks.filter((c) =>
        c.name.toLowerCase().includes('typecheck')
      );
      expect(typecheckChecks).toHaveLength(0);
      expect(result.limitations).toContain(
        'No tsconfig.json found; TypeScript check skipped'
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should handle concurrent preflight runs safely', async () => {
    const config = {
      checks: {
        gitState: true,
        lint: true,
        typecheck: true,
      },
    };

    // Run multiple preflight checks concurrently
    const promises = [
      runPreflight('.', config),
      runPreflight('.', config),
      runPreflight('.', config),
    ];

    const results = await Promise.all(promises);

    // All should complete successfully
    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result).toBeDefined();
      expect(result.checks).toBeInstanceOf(Array);
    });
  }, 45000); // Increase timeout for concurrent runs with git state checks

  it('should handle disabled checks without errors', async () => {
    const config = {
      checks: {
        lint: false,
        typecheck: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    };

    const result = await runPreflight('.', config);

    // Should complete with empty or minimal checks
    expect(result).toBeDefined();
    expect(result.checks.length).toBeGreaterThanOrEqual(0);
    expect(result.ready).toBeDefined();
  });

  it('should handle malformed command output gracefully', async () => {
    // This tests that check runners handle unexpected command outputs
    const config = {
      checks: {
        lint: true,
      },
    };

    // Even if lint commands produce weird output, should not crash
    const result = await runPreflight('.', config);
    expect(result).toBeDefined();
  });

  it('should provide meaningful error context in check results', async () => {
    const config = {
      checks: {
        typecheck: true,
      },
    };

    const result = await runPreflight('.', config);

    // Failed checks should have meaningful messages
    const failedChecks = result.checks.filter((c) => c.status === 'fail');
    failedChecks.forEach((check) => {
      expect(check.message || check.name).toBeTruthy();
      expect(typeof (check.message || check.name)).toBe('string');
    });
  });

  it('should maintain JSON output contract even on errors', async () => {
    const config = {
      checks: {
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      customChecks: [
        {
          name: 'failing-contract-check',
          command: 'false',
          failOnError: true,
        },
      ],
    };

    const result = await runPreflight('.', config);

    // Even with failures, output should have required fields
    expect(result).toHaveProperty('ready');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('blockers');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('limitations');
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('timestamp');

    // Types should be correct
    expect(typeof result.ready).toBe('boolean');
    expect(typeof result.confidence).toBe('number');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.limitations)).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.timestamp).toBe('string');
  });
});
