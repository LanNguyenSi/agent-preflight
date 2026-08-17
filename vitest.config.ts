import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Structural guard (task 086ac782): fails the whole run if any test
    // wrote into the real ~/.agent-preflight/logs instead of an overridden
    // logDir. See the docblock in the guard file itself for why this is a
    // globalSetup rather than a per-file setupFiles stub or pin test.
    globalSetup: ["tests/setup/no-real-home-writes.globalSetup.ts"],
    testTimeout: 30_000, // integration tests with lint/audit checks can take >5s on CI
    // 19 of the 22 test files call runPreflight('.'), which spawns this repo's
    // real `npm run lint` / `tsc` as child processes. On CI's 2-core
    // ubuntu-latest runner this contends for CPU and pushes normally-~6s
    // tests past the 30s testTimeout (flaky main-branch failures, see the CI
    // incident this fix addresses).
    //
    // maxWorkers: 2 (matching the runner's core count) is NOT enough: the
    // actual failing CI run already measured ~2 concurrent workers by
    // default (sum of per-file durations 188.1s / observed wall clock 93.5s
    // = 2.01x), so bounding to 2 changes nothing there. The two heaviest
    // files, contract/integrations.test.ts (~92.4s) and
    // integration/error-handling.test.ts (~58.9s), can still land on
    // separate workers and run concurrently at maxWorkers 2, and that
    // overlap is exactly what pushes their ~6s tests past 30s. Only forcing
    // test files to run one at a time removes the overlap.
    //
    // Measured locally (12-core machine, `npx vitest run --coverage`):
    //   default (unbounded file parallelism): ~86s
    //   maxWorkers: 2 (rejected, see above):   ~92s
    //   fileParallelism: false (this setting): ~161s
    // Fully serial cap. Expected CI cost: per-file-duration sum stays
    // ~188s but now runs serially instead of overlapping, so CI wall clock
    // for this step goes from ~93s to roughly ~190s (job moves from ~2m31s
    // to ~4min). That cost is accepted: the operator chose determinism over
    // speed and explicitly rejected raising testTimeout instead. Do not
    // change this back to a worker cap > 1 without first re-measuring
    // effective CI concurrency from actual run logs, not local timings.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Thresholds ratcheted to current measured actuals (2026-06-28 baseline):
      //   statements 80.39 | branches 68.88 | functions 95.27 | lines 80.88
      // Set 1-2 points below measured to avoid immediate red while still gating regressions.
      // functions is set nearer the measured 95 to gate regressions on that axis.
      thresholds: {
        statements: 79,
        branches: 67,
        functions: 93,
        lines: 79,
      },
    },
  },
});
