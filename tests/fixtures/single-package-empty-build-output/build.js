// An ordinary build. The point of this fixture is the state BEFORE it runs:
// the test creates an EMPTY dist/ (git cannot carry an empty directory, so it
// is made at run time), which is still "not built yet" and must not be read
// as a partially built package.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.js"), "module.exports = {};\n");
