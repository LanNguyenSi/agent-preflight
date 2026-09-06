// This package declares no entry points at all, so the precondition falls back
// to "dist/ does not exist" -- which is true here. The failure is an ordinary
// wrong assertion, and the only path in the output that contains the word
// "dist" is the test runner's own stack frame inside node_modules. A rule that
// looked for the substring "dist/" would read this as "not built yet" and
// report a genuinely broken suite as ready.
console.error("AssertionError [ERR_ASSERTION]: 2 !== 3");
console.error("    at Object.<anonymous> (/opt/tools/node_modules/vitest/dist/chunks/runBaseTests.js:114:5)");
console.error("    at file:///opt/tools/node_modules/vitest/dist/entry.js:12:9");
process.exit(1);
