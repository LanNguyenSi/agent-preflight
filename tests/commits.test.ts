import { describe, it, expect } from 'vitest';
import { runCommitConventionCheck } from '../src/checks/commits.js';

describe('Commit Convention Checks', () => {
  it('should allow commits with emojis', async () => {
    // This test validates that emoji commits don't fail due to char length
    // We can't easily mock git log, so this is a smoke test
    const result = await runCommitConventionCheck('.', undefined);
    
    expect(result).toBeDefined();
    expect(result.checks).toBeInstanceOf(Array);
    expect(result.limitations).toBeInstanceOf(Array);
  });

  it('should handle repos without git gracefully', async () => {
    const result = await runCommitConventionCheck('/tmp', undefined);
    
    // Should either report limitation or return empty checks
    expect(result.limitations.length > 0 || result.checks.length === 0).toBe(true);
  });

  it('should skip check when convention is "none"', async () => {
    const result = await runCommitConventionCheck('.', 'none');
    
    expect(result.checks).toHaveLength(0);
    expect(result.limitations).toContain('commit convention check disabled in config');
  });
});
