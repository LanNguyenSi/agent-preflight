// Never invoked by the test that uses this fixture; it exists so the package
// genuinely satisfies the "has a build script" half of the precondition.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.js"), "module.exports = {};\n");
