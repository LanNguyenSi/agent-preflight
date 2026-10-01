import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runPreflight } from "../src/runner.js";
import { CHECK_KINDS, CheckKind, CheckResult, PreflightConfig } from "../src/types.js";

const fixtures = vi.hoisted(() => {
  const state = { checks: [] as CheckResult[] };
  const results = async (kind: CheckKind) => ({
    checks: state.checks.filter((check) => check.kind === kind),
    limitations: [] as string[],
  });
  return { state, results };
});

vi.mock("../src/checks/git.js", () => ({
  runGitStateChecks: () => fixtures.results("git-state"),
  snapshotWorktreeState: vi.fn(),
}));
vi.mock("../src/checks/lint.js", () => ({ runLintChecks: () => fixtures.results("lint") }));
vi.mock("../src/checks/typecheck.js", () => ({ runTypecheckChecks: () => fixtures.results("typecheck") }));
vi.mock("../src/checks/test.js", () => ({ runTestChecks: () => fixtures.results("test") }));
vi.mock("../src/checks/audit.js", () => ({ runAuditChecks: () => fixtures.results("audit") }));
vi.mock("../src/checks/ci.js", () => ({ runCiSimulation: () => fixtures.results("ci-simulation") }));
vi.mock("../src/checks/commits.js", () => ({ runCommitConventionCheck: () => fixtures.results("commit-convention") }));
vi.mock("../src/checks/secrets.js", () => ({ runSecretDetection: () => fixtures.results("secret-detection") }));
vi.mock("../src/checks/tdd.js", () => ({ runTddCheck: () => fixtures.results("tdd") }));
vi.mock("../src/checks/custom.js", () => ({ runCustomChecks: () => fixtures.results("custom") }));

const toggles: Record<Exclude<CheckKind, "custom">, keyof NonNullable<PreflightConfig["checks"]>> = {
  "git-state": "gitState",
  lint: "lint",
  typecheck: "typecheck",
  test: "test",
  audit: "audit",
  "ci-simulation": "ciSimulation",
  "commit-convention": "commitConvention",
  "secret-detection": "secretDetection",
  tdd: "tdd",
};

function check(kind: CheckKind, status: CheckResult["status"] = "pass", name = `${kind}:1`): CheckResult {
  return { kind, status, name, message: `${name}: ${status}`, durationMs: 1, confidenceContribution: 0.2 };
}

describe("requiredChecks", () => {
  let repoPath: string;
  let config: PreflightConfig;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-required-"));
    fixtures.state.checks = [];
    config = {
      logDir: path.join(repoPath, "logs"),
      checks: Object.fromEntries(Object.values(toggles).map((key) => [key, true])),
      customChecks: [{ name: "mocked-custom", command: "true" }],
    };
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it.each(CHECK_KINDS)("accepts %s only when its results pass", async (kind) => {
    config.requiredChecks = [kind];
    fixtures.state.checks = [check(kind), check(kind, "pass", `${kind}:2`)];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.checks).toEqual(fixtures.state.checks);
  });

  it.each(CHECK_KINDS)("blocks absent %s results without inventing a check", async (kind) => {
    config.requiredChecks = [kind];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([expect.stringContaining(`"${kind}" produced no results`)]);
    expect(result.checks).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  it.each(Object.entries(toggles))("blocks disabled %s with an explicit diagnostic", async (kind, toggle) => {
    config.requiredChecks = [kind as CheckKind];
    config.checks![toggle as keyof NonNullable<PreflightConfig["checks"]>] = false;
    fixtures.state.checks = [check(kind as CheckKind)];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([expect.stringContaining(`checks.${toggle} is disabled`)]);
    expect(result.checks).toEqual([]);
  });

  it("explains that CI simulation must be enabled explicitly", async () => {
    config.requiredChecks = ["ci-simulation"];
    config.checks!.ciSimulation = undefined;
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([expect.stringContaining("checks.ciSimulation is not enabled")]);
  });

  it.each(["skip", "warn", "acknowledged", "fail"] as const)("blocks a %s among passing results and preserves statuses and confidence", async (status) => {
    fixtures.state.checks = [check("test"), check("test", status, "integration")];
    const original = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    config.requiredChecks = ["test"];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(`Required check kind "test" must pass every result: "integration" (${status})`);
    expect(result.checks).toEqual(original.checks);
    expect(result.confidence).toBe(original.confidence);
    expect(result.warnings).toEqual(original.warnings);
    expect(result.limitations).toEqual(original.limitations);
  });

  it("enforces every required kind even when a different required kind passes", async () => {
    config.requiredChecks = ["lint", "test"];
    fixtures.state.checks = [check("lint")];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([expect.stringContaining('"test" produced no results')]);
  });

  it("evaluates acknowledgements before the gate and preserves the waiver reason", async () => {
    config.requiredChecks = ["test"];
    config.checks!.test = { acknowledge: "requires a separate environment" };
    fixtures.state.checks = [check("test", "fail")];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.checks[0].status).toBe("acknowledged");
    expect(result.checks[0].message).toContain("requires a separate environment");
    expect(result.blockers).toEqual(['Required check kind "test" must pass every result: "test:1" (acknowledged)']);
    expect(result.limitations).toEqual([expect.stringContaining("requires a separate environment")]);
  });

  it("ignores duplicate requirements without duplicating blockers", async () => {
    config.requiredChecks = ["test", "test"];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(1);
  });

  it.each([{ requiredChecks: undefined }, { requiredChecks: [] }])("retains the default gate when the policy is $requiredChecks", async ({ requiredChecks }) => {
    config.requiredChecks = requiredChecks;
    fixtures.state.checks = [check("test", "skip"), check("lint", "warn"), check("audit", "acknowledged")];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    fixtures.state.checks = [];
    expect((await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") })).ready).toBe(true);
  });

  it("does not waive failures of unrequired kinds", async () => {
    config.requiredChecks = ["test"];
    fixtures.state.checks = [check("test"), check("lint", "fail")];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(["lint:1: fail"]);
  });

  it.each([null, false, "test", {}, ["unknown"], ["test", null], ["gitState"], [" test"], Array(1)].map((value) => ({ value })))("blocks malformed programmatic policy $value", async ({ value }) => {
    config.requiredChecks = value as CheckKind[];
    fixtures.state.checks = [check("test")];
    const result = await runPreflight(repoPath, { ...config, logDir: path.join(repoPath, "logs") });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([expect.stringContaining("requiredChecks")]);
    expect(result.checks).toEqual(fixtures.state.checks);
  });
});
