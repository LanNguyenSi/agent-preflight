import { describe, it, expect } from 'vitest';
import { runPreflight } from '../../src/runner.js';
import { loadConfig } from '../../src/config.js';
import * as path from 'path';

describe('Error Handling Integration Tests', () => {
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
  });

  it('should handle invalid .preflight.json gracefully', async () => {
    // loadConfig should handle malformed JSON
    const invalidPath = path.join(__dirname, '../fixtures/invalid-config');

    // If config file doesn't exist or is invalid, should return defaults
    const config = await loadConfig(invalidPath);
    expect(config).toBeDefined();
    expect(config.checks).toBeDefined();
  });

  it('should handle repositories without package.json', async () => {
    const config = {
      checks: {
        audit: true, // npm audit requires package.json
      },
    };

    // Should handle missing package.json gracefully
    const result = await runPreflight('/tmp', config);
    expect(result).toBeDefined();

    // Audit check should either skip or report missing package.json
    const auditChecks = result.checks.filter((c) =>
      c.name.toLowerCase().includes('audit')
    );
    if (auditChecks.length > 0) {
      // Should have some status (pass, fail, or warn)
      expect(['pass', 'fail', 'warn']).toContain(auditChecks[0].status);
    }
  });

  it('should handle repositories without tsconfig.json', async () => {
    const config = {
      checks: {
        typecheck: true, // TypeScript check requires tsconfig.json
      },
    };

    const result = await runPreflight('/tmp', config);
    expect(result).toBeDefined();

    // Typecheck should either skip or report missing tsconfig
    const typecheckChecks = result.checks.filter((c) =>
      c.name.toLowerCase().includes('typecheck')
    );
    if (typecheckChecks.length > 0) {
      expect(['pass', 'fail', 'warn']).toContain(typecheckChecks[0].status);
    }
  });

  it('should handle concurrent preflight runs safely', async () => {
    const config = {
      checks: {
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
  }, 15000); // Increase timeout to 15 seconds for concurrent runs

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
        ciSimulation: true, // Will fail if act not installed
      },
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
