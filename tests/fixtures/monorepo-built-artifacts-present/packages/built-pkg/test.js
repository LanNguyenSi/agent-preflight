// Mixed output from an ALREADY BUILT workspace: a relative `./dist/...`
// module error (for a file this package never declared and its build never
// produces) next to an ordinary assertion failure.
const assert = require("assert");

require("./dist/index.js");

try {
  require("./dist/helpr.js");
} catch (err) {
  console.error(`Error: ${String(err.message).split("\n")[0]}`);
}

assert.strictEqual(1 + 1, 3, "deliberately wrong assertion (genuine bug)");
