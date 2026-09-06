// Same dist/-requiring test as the other build-required fixtures. Never
// reached in a passing state here: the build step above always fails
// first, so dist/ is never produced.
const assert = require("assert");
const mod = require("./dist/index.js");

assert.strictEqual(mod.hello(), "hello");
console.log("needs-build test passed");
