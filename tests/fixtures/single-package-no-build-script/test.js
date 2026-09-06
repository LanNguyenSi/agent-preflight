// Same dist/-requiring test shape as the monorepo fixtures, but this
// package is NOT a workspaces monorepo and has no `build` script at all
// (round-2 review MEDIUM-2): the remedy must not suggest `npm run build`
// or `--setup`, since neither would do anything here.
const assert = require("assert");
const mod = require("./dist/index.js");

assert.strictEqual(mod.hello(), "hello");
console.log("test passed");
