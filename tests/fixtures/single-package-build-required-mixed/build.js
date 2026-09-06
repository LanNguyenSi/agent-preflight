// Fixture "build": writes the dist/index.js this package declares as `main`.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "module.exports = { hello: () => \"hello\" };\n"
);
