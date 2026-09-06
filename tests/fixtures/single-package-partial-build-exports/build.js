// Emits the main entry point only. The `./extra` subpath is declared but was
// dropped from the build, so dist/extra.js stays missing after every build.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "exports.f = () => {\n  throw new Error(\"genuine regression\");\n};\n"
);
