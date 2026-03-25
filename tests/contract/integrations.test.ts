import { describe, it, expect } from 'vitest';
import { runPreflight } from '../../src/runner.js';
import type { PreflightResult, CheckResult } from '../../src/types.js';

describe('Contract Tests - JSON Output Stability', () => {
  // All tests in this suite may run lint/checks — increase timeout for CI runners
  const TEST_TIMEOUT = 30_000;
  it('should maintain stable JSON schema for agent consumption', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: false,
      },
    };

    const result: PreflightResult = await runPreflight('.', config);

    // Core contract: Required top-level fields
    expect(result).toHaveProperty('ready');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('blockers');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('limitations');
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('timestamp');

    // Field types (stable API contract)
    expect(typeof result.ready).toBe('boolean');
    expect(typeof result.confidence).toBe('number');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.limitations)).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.timestamp).toBe('string');

    // Value constraints
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('should maintain stable CheckResult schema', async () => {
    const config = {
      checks: {
        lint: false, // avoid eslint slowness on CI
        typecheck: false,
        commitConvention: true,
        secretDetection: true,
      },
    };

    const result = await runPreflight('.', config);

    if (result.checks.length > 0) {
      const check: CheckResult = result.checks[0];

      // Required check fields
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('confidenceContribution');

      // Field types
      expect(typeof check.name).toBe('string');
      expect(['pass', 'fail', 'warn']).toContain(check.status);
      expect(typeof check.confidenceContribution).toBe('number');

      // Optional fields should have correct types if present
      if (check.message !== undefined) {
        expect(typeof check.message).toBe('string');
      }
    }
  });

  it('should produce parseable JSON output', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: true,
      },
    };

    const result = await runPreflight('.', config);

    // Should be JSON-serializable
    const json = JSON.stringify(result);
    expect(json).toBeTruthy();

    // Should be parseable
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(result);
  });

  it('should have stable confidence calculation', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: true,
        audit: true,
        secretDetection: true,
        commitConvention: true,
      },
    };

    // Run twice with same config
    const result1 = await runPreflight('.', config);
    const result2 = await runPreflight('.', config);

    // Confidence should be deterministic (same input = same output)
    // Allow small floating-point variance
    expect(Math.abs(result1.confidence - result2.confidence)).toBeLessThan(0.01);
  }, 30000); // Running the same full preflight twice can exceed 15s on slower environments

  it('should maintain backward-compatible limitation messages', async () => {
    const config = {
      checks: {
        ciSimulation: false,
        secretDetection: true,
      },
    };

    const result = await runPreflight('.', config);

    // Known limitation messages that agents may depend on
    const ciSimLimitation = result.limitations.find((l) =>
      l.includes('CI simulation skipped')
    );
    expect(ciSimLimitation).toBeTruthy();

    const secretLimitation = result.limitations.find((l) =>
      l.includes('secret detection') && l.includes('pattern')
    );
    expect(secretLimitation).toBeTruthy();
  });

  it('should maintain blocker/warning separation contract', async () => {
    const config = {
      checks: {
        lint: true,
        audit: true,
      },
    };

    const result = await runPreflight('.', config);

    // Blockers = fail checks
    // Warnings = warn checks
    // They should never overlap
    const blockerSet = new Set(result.blockers);
    const warningSet = new Set(result.warnings);

    const overlap = [...blockerSet].filter((b) => warningSet.has(b));
    expect(overlap).toHaveLength(0);
  });

  it('should maintain ready flag contract', async () => {
    const config = {
      checks: {
        lint: true,
      },
    };

    const result = await runPreflight('.', config);

    // ready = no blockers (confidence is separate signal, not a gate)
    if (result.blockers.length === 0) {
      expect(result.ready).toBe(true);
    } else {
      expect(result.ready).toBe(false);
    }
  });

  it('should maintain timestamp ISO 8601 format', async () => {
    const config = {};
    const result = await runPreflight('.', config);

    // Timestamp should be valid ISO 8601
    const date = new Date(result.timestamp);
    expect(date.toString()).not.toBe('Invalid Date');

    // Should match ISO format
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should deduplicate limitations', async () => {
    const config = {
      checks: {
        secretDetection: true,
      },
    };

    const result = await runPreflight('.', config);

    // Limitations should be unique (no duplicates)
    const uniqueLimitations = [...new Set(result.limitations)];
    expect(result.limitations).toEqual(uniqueLimitations);
  });

  it('should maintain check name stability for agent parsing', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: true,
        audit: true,
        secretDetection: true,
        commitConvention: true,
      },
    };

    const result = await runPreflight('.', config);

    // Check names should be predictable strings
    result.checks.forEach((check) => {
      expect(check.name).toBeTruthy();
      expect(typeof check.name).toBe('string');
      expect(check.name.length).toBeGreaterThan(0);

      // Names should not contain special characters that break parsing
      expect(check.name).toMatch(/^[a-zA-Z0-9\s\-_.:()]+$/);
    });
  });
});
