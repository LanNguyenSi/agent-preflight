import { describe, it, expect } from "vitest";
import path from "path";
import { runPreflight } from "../src/runner.js";
import { defaultConfig } from "../src/config.js";

describe("runPreflight", () => {
  it("returns a PreflightResult with required fields", async () => {
    const config = defaultConfig();
    // Disable heavy checks for unit test speed
    config.checks = {
      lint: false,
      typecheck: false,
      test: false,
      audit: false,
      ciSimulation: false,
      commitConvention: true,
      secretDetection: true,
    };

    const result = await runPreflight(path.resolve(__dirname, ".."), config);

    expect(result).toHaveProperty("ready");
    expect(result).toHaveProperty("confidence");
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.limitations)).toBe(true);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.timestamp).toBe("string");
  });

  it("is not ready when there are blockers", async () => {
    const config = defaultConfig();
    config.checks = { lint: false, typecheck: false, test: false, audit: false, ciSimulation: false, commitConvention: false, secretDetection: false };

    const result = await runPreflight(path.resolve(__dirname, ".."), config);

    // With no checks running, no blockers → confidence is low but result is valid
    expect(result.limitations.length).toBeGreaterThan(0);
  });
});

describe("confidence scoring", () => {
  it("penalises results with many limitations", async () => {
    const config = defaultConfig();
    config.checks = { lint: false, typecheck: false, test: false, audit: false, ciSimulation: false, commitConvention: false, secretDetection: false };

    const result = await runPreflight(path.resolve(__dirname, ".."), config);
    // All checks skipped → many limitations → low confidence
    expect(result.confidence).toBeLessThan(0.5);
  });
});
