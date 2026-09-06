// Fixture "build": writes dist/index.js. Same shape as the other
// build-required fixtures; duplicated to keep each fixture
// self-contained.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "module.exports = { hello: () => \"hello\" };\n"
);
