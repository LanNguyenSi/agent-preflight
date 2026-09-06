// Emits the main entry point only. The declared `bin` was dropped from the
// build and is never emitted, so `dist/cli.js` stays missing after every
// build while `dist/` itself fills up.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.js"), "module.exports = {};\n");
