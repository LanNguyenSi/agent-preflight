// Genuine bug, unrelated to any build/dist precondition -- must stay a
// blocking failure even though it sits in the SAME monorepo run as
// "needs-build" (round-2 review HIGH-1: one build-required workspace must
// never hide a different workspace's real failure).
const assert = require("assert");

assert.strictEqual(1 + 1, 3, "deliberately wrong assertion (unrelated genuine bug)");
