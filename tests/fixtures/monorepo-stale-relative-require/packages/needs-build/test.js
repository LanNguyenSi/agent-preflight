const assert = require("assert");
const mod = require("./dist/index.js");

assert.strictEqual(mod.hello(), "hello");
console.log("needs-build test passed");
