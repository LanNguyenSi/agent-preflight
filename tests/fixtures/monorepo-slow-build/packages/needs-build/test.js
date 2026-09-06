// Fixture "test": requires the built dist/ output, the same way a real
// workspace's cli-dist.test.ts requires its own package's dist/. When
// dist/ has not been built yet, this `require` throws Node's own
// "Cannot find module './dist/index.js'" error, failing loudly -- this
// is the reproduction of the reported friction, not a fabricated message.
const assert = require("assert");
const mod = require("./dist/index.js");

assert.strictEqual(mod.hello(), "hello");
console.log("needs-build test passed");
