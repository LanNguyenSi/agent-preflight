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
    // Re-measured (task 7fb922e4, 2026-09-12) after task 580b3171/PR #73 cut
    // integration/error-handling.test.ts from ~58.9s to ~7-22s by no longer
    // scanning the shared /tmp: that file is no longer one of the two
    // heaviest, but the underlying overlap risk is unchanged because two
    // other files spawn the same many-runPreflight() child processes.
    //
    // Measured locally (`npx vitest run --coverage --reporter=verbose`,
    // this setting, unrelated machine specs omitted): total 116.5s. Per-file,
    // heaviest first: build-required.test.ts ~36.5s (max single case 7.8s,
    // 52 runPreflight() calls), contract/integrations.test.ts ~16.3s (max
    // single case 3.1s, 13 calls), install.test.ts ~12.0s, secrets.test.ts
    // ~8.8s, integration/error-handling.test.ts now ~7.2s (was ~58.9s).
    //
    // Measured on CI (latest green run on main, this setting, 2-core
    // ubuntu-latest): sum of per-file durations 147.7s equals the observed
    // step wall clock (vitest's own "tests 147.73s"), confirming this is a
    // fully serial run. Per-file, heaviest first: build-required.test.ts
    // ~45.9s, contract/integrations.test.ts ~41.3s,
    // integration/error-handling.test.ts now ~21.8s (was ~58.9s).
    //
    // Decision: keep fileParallelism: false. The two current heaviest files
    // (build-required.test.ts, contract/integrations.test.ts) still spawn
    // many runPreflight() child processes each, the same contention
    // mechanism that caused the original incident, and their combined
    // CI duration (~87s) is well over the 30s testTimeout. Locally their
    // slowest individual cases already run 7.8s and 3.1s. Whether those two
    // files would overlap dangerously under a worker cap was NOT measured
    // in this round (no CI run with parallelism enabled was taken), so the
    // serial cap stays on the strength of the per-file durations alone.
    // Re-enabling any parallelism (maxWorkers > 1 or the
    // default) would need a fresh CI measurement of actual concurrent
    // overlap between build-required.test.ts and contract/integrations.test.ts,
    // and five consecutive green CI runs confirming no timeout, before it
    // replaces this comment. Do not change this back to a worker cap > 1
    // without doing that re-measurement from actual run logs, not local
    // timings. testTimeout stays 30s: the operator already rejected raising
    // it instead of fixing the parallelism.
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
