// Fixture "build": writes dist/index.js. See
// tests/fixtures/monorepo-build-required/packages/needs-build/build.js for
// the full rationale (shared shape, duplicated here so this fixture has no
// cross-fixture dependency).
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "module.exports = { hello: () => \"hello\" };\n"
);
