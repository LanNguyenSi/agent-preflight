// Negative control: a genuine bug, unrelated to any build/dist precondition.
// Must stay a blocking failure in every state -- the build-required
// classifier must never reclassify this.
const assert = require("assert");

assert.strictEqual(1 + 1, 3, "deliberately wrong assertion (negative control)");
