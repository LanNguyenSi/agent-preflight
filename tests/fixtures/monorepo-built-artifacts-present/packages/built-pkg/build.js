// Produces only the declared entry point. dist/helpr.js is deliberately NOT
// produced: after a build, the package's declared artifacts are all present,
// and the test's failure to load some other file inside dist/ is a real bug,
// not a missing build.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "dist", "index.js"),
  "module.exports = { hello: () => \"hello\" };\n"
);
