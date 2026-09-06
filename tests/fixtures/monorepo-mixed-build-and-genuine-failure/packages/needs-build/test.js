// Fixture "test": requires the built dist/ output. See
// tests/fixtures/monorepo-build-required/packages/needs-build/test.js for
// the full rationale.
const assert = require("assert");
const mod = require("./dist/index.js");

assert.strictEqual(mod.hello(), "hello");
console.log("needs-build test passed");
