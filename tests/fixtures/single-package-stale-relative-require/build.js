// Produces the declared artifact, so the precondition is genuinely "unbuilt"
// until this runs. It never produces src/renamed-away.js: the test's failure
// is a stale reference, not a missing build.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.js"), "module.exports = {};\n");
