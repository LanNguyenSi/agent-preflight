// Builds into lib/, which the declared `dist` is a symlink to. The package is
// unbuilt until this runs: lib/ exists (it is checked in, holding only .keep)
// but lib/index.js does not.
const fs = require("fs");
const path = require("path");

fs.writeFileSync(path.join(__dirname, "lib", "index.js"), "module.exports = {};\n");
