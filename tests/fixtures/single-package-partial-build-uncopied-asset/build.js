// A JavaScript-only build for a package that also declares `types`: it emits
// dist/index.js and never emits dist/index.d.ts, so the declared `types`
// artifact stays missing however often this runs. The built code reads a
// template out of dist/templates/, which this build never copies -- the
// genuine bug the test hits.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "const fs = require(\"fs\");\nconst path = require(\"path\");\nexports.render = () => fs.readFileSync(path.join(__dirname, \"templates\", \"page.html\"), \"utf8\");\n"
);
