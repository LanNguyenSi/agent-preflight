// Unbuilt, this fails on the entry point (a plain missing build). Built, the
// entry point loads and the failure moves to the stylesheet in the OTHER
// declared output directory, which no build here ever writes.
const fs = require("fs");
const path = require("path");

require("./dist/index.js");

const styles = path.join(__dirname, "lib", "styles.css");
if (!fs.existsSync(styles)) {
  console.error("Error: ENOENT: no such file or directory, open './lib/styles.css'");
  process.exit(1);
}
