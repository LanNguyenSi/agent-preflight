// Fixture "build": writes dist/index.js. Intentionally trivial (no
// TypeScript, no bundler) so the fixture has zero external dependencies and
// runs fast in CI. Stands in for a real project's `tsc`/bundler build step.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "module.exports = { hello: () => \"hello\" };\n"
);
