// A dependency that was never installed, reported by its resolved path. The
// path ends in `dist/index.js` -- byte-for-byte the tail of this package's own
// declared artifact -- but it lives under node_modules, so it names a missing
// DEPENDENCY that no build of this repo produces. Printed twice, once inside
// this repo's own node_modules and once from elsewhere on the machine.
const path = require("path");

console.error(
  `Error: Cannot find module '${path.join(__dirname, "node_modules", "some-lib", "dist", "index.js")}'`
);
console.error("Error: Cannot find module '/opt/shared/node_modules/some-lib/dist/index.js'");
process.exit(1);
