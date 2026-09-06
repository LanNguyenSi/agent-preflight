// A build that fills only the FIRST of the two output directories this package
// declares: dist/ gets the entry point, lib/ never gets the stylesheet the
// `./styles` export names. After it runs, dist/ holds the build and lib/ does
// not exist, so the missing artifact's own directory says "unbuilt" while the
// package plainly is not.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.js"), "module.exports = {};\n");
