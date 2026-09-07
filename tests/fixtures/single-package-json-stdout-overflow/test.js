// A genuinely failing test whose output alone is large enough to push the
// `preflight run --json` envelope past a pipe's kernel buffer capacity
// (commonly 64 KB / 65536 bytes on Linux and macOS): task 0089e6f5. This is
// deliberately bigger than the T-008 pathological-path-token fixture
// (tests/fixtures/single-package-pathological-path-token), whose 30000-segment
// token measures under that threshold on this repo's dev/CI machines, so it
// never actually exercised the pipe-write race the stdout-flush fix
// addresses; this fixture's larger token does.
//
// `process.exitCode` (not `process.exit(1)`) is deliberate: this script's
// own stdout is itself captured through a pipe by whatever spawns `npm
// test`, so an immediate `process.exit()` right after `console.error` would
// hit the very same truncation race one level down and cap this fixture's
// own captured output at the pipe's buffer size, regardless of how large the
// token below is. Setting `exitCode` and letting the event loop drain
// naturally flushes the write before the process exits non-zero.
console.error("Error: Cannot find module './" + "a/".repeat(120000) + "x.js'");
process.exitCode = 1;
