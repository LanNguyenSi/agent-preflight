// A JS-only build for a package that also declares `types`. It emits
// dist/index.js and never emits dist/index.d.ts, so the declared `types`
// artifact stays missing however often this runs -- the real shape of a
// package whose declarations were dropped (or were never generated).
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "exports.add = () => {\n  throw new Error(\"boom: real bug\");\n};\n"
);
