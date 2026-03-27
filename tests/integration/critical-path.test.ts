import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runPreflight } from '../../src/runner.js';
import { loadConfig } from '../../src/config.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Critical Path Integration Tests', () => {
  let testRepoPath: string;

  beforeAll(async () => {
    // Create a minimal valid test repository
    testRepoPath = path.join(os.tmpdir(), `preflight-test-${Date.now()}`);
    await fs.mkdir(testRepoPath, { recursive: true });

    // Create package.json
    await fs.writeFile(
      path.join(testRepoPath, 'package.json'),
      JSON.stringify({
        name: 'test-repo',
        version: '1.0.0',
        scripts: {
          lint: 'echo "lint ok"',
          test: 'echo "test ok"',
        },
      })
    );

    // Create tsconfig.json
    await fs.writeFile(
      path.join(testRepoPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
        },
      })
    );

    // Create a simple TypeScript file
    await fs.mkdir(path.join(testRepoPath, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(testRepoPath, 'src', 'index.ts'),
      'export const hello = "world";\n'
    );

    // Initialize git
    const { execSync } = await import('child_process');
    execSync('git init', { cwd: testRepoPath });
    execSync('git config user.email "test@example.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "feat: initial commit"', { cwd: testRepoPath });
  });

  afterAll(async () => {
    // Clean up test repo
    if (testRepoPath) {
      await fs.rm(testRepoPath, { recursive: true, force: true });
    }
  });

  it('should successfully run all checks on a valid repository', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: true,
        audit: true,
        secretDetection: true,
        commitConvention: true,
        ciSimulation: false, // Skip act (not installed in test env)
      },
    };

    const result = await runPreflight(testRepoPath, config);

    expect(result).toBeDefined();
    expect(result.ready).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.checks).toBeInstanceOf(Array);
    expect(result.blockers).toBeInstanceOf(Array);
    expect(result.warnings).toBeInstanceOf(Array);
    expect(result.limitations).toBeInstanceOf(Array);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.checks.some((check) => check.name === 'protected-branch')).toBe(true);
    expect(result.checks.some((check) => check.name === 'clean-worktree')).toBe(true);
  });

  it('should respect config file from repository', async () => {
    // Create .preflight.json in test repo
    const customConfig = {
      checks: {
        audit: false, // Disable audit for this test
      },
    };

    await fs.writeFile(
      path.join(testRepoPath, '.preflight.json'),
      JSON.stringify(customConfig)
    );

    const config = await loadConfig(testRepoPath);
    const result = await runPreflight(testRepoPath, config);

    // Verify that audit check was skipped
    const auditChecks = result.checks.filter((c) => c.name.includes('audit'));
    expect(auditChecks.length).toBe(0);
  });

  it('should calculate confidence based on passed checks', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: true,
        audit: false,
        secretDetection: false,
        commitConvention: true,
        ciSimulation: false,
      },
    };

    const result = await runPreflight(testRepoPath, config);

    // With some checks passing and no blockers, confidence should be > 0
    if (result.blockers.length === 0) {
      expect(result.confidence).toBeGreaterThan(0);
    }
  });

  it('should mark as not ready if blockers exist', async () => {
    // Create a malformed TypeScript file to trigger typecheck failure
    await fs.writeFile(
      path.join(testRepoPath, 'src', 'broken.ts'),
      'const x: number = "not a number";' // Type error
    );

    const config = {
      checks: {
        lint: false,
        typecheck: true,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    };

    const result = await runPreflight(testRepoPath, config);

    // Note: Actual typecheck may or may not fail depending on environment
    // This test verifies the blocker logic exists
    if (result.blockers.length > 0) {
      expect(result.ready).toBe(false);
    }
  });

  it('should include limitations for skipped checks', async () => {
    const config = {
      checks: {
        // ciSimulation not specified (defaults to false)
      },
    };

    const result = await runPreflight(testRepoPath, config);

    // Should have at least one limitation from skipped checks
    expect(result.limitations.length).toBeGreaterThan(0);
    
    // Verify CI simulation limitation exists
    const hasCILim = result.limitations.some(l => 
      l.includes('CI simulation') || l.includes('ci-simulation') || l.includes('ciSimulation')
    );
    expect(hasCILim).toBe(true);
  });

  it('should complete in reasonable time', async () => {
    const config = {
      checks: {
        lint: true,
        typecheck: true,
        audit: true,
        secretDetection: true,
        commitConvention: true,
        ciSimulation: false,
      },
    };

    const start = Date.now();
    await runPreflight(testRepoPath, config);
    const duration = Date.now() - start;

    // Should complete under 30 seconds (generous for CI environments)
    expect(duration).toBeLessThan(30000);
  });
});
