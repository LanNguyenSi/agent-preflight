// A single-package repo whose suite reports BOTH shapes in one run: a module
// that cannot be loaded because the package has not been built, and an
// ordinary assertion failure. Unbuilt, the whole run is "not evaluated"
// (the suite never got to run against the code it is supposed to test);
// built, the surviving assertion failure is a genuine blocker.
const assert = require("assert");

try {
  require("./dist/index.js");
} catch (err) {
  console.error(`Error: ${String(err.message).split("\n")[0]}`);
}

assert.strictEqual(1 + 1, 3, "deliberately wrong assertion (unrelated to the build)");
