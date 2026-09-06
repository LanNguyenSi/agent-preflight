// Same genuine bug as monorepo-mixed-build-and-genuine-failure's z-broken,
// but in a directory that npm's workspace fan-out reaches FIRST, so the
// evaluation cannot depend on which failing workspace npm happens to print
// before the other.
const assert = require("assert");

assert.strictEqual(1 + 1, 3, "deliberately wrong assertion (unrelated genuine bug)");
