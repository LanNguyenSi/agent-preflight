// The workspace shape of the same partial build: dist/index.js is emitted,
// the declared dist/index.d.ts never is, and dist/templates/ is never copied.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "const fs = require(\"fs\");\nconst path = require(\"path\");\nexports.render = () => fs.readFileSync(path.join(__dirname, \"templates\", \"page.html\"), \"utf8\");\n"
);
