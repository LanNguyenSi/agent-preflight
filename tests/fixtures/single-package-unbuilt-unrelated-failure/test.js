// The package IS unbuilt (dist/index.js, its declared `main`, is missing) and
// it DOES have a build script, so the filesystem precondition holds -- but the
// suite runs from source and fails for a reason that has nothing to do with
// the build. Nothing in this output names the missing artifact, so the failure
// must stay a blocker.
const assert = require("assert");

assert.strictEqual(1 + 1, 3, "deliberately wrong assertion (unrelated to the build)");
