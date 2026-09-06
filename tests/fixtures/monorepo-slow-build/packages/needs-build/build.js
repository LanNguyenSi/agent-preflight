// Fixture "build" that outlasts a small `setup.buildTimeoutMs`, so the
// --setup build step is cut short and dist/ is never produced. Deliberately
// a plain timer (no external dependency) and only a few seconds long: the
// test configures a timeout far below it, so a working timeout ends the run
// immediately and only a BROKEN timeout pays the full wait.
const fs = require("fs");
const path = require("path");

setTimeout(() => {
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "dist", "index.js"),
    "module.exports = { hello: () => \"hello\" };\n"
  );
}, 4000);
