// The shape the reported friction actually had: a test whose first assertion
// is that the package was built, throwing its OWN message with the ABSOLUTE
// artifact path in it (no `Cannot find module`, no `Error:` prefix of Node's
// making). Nothing but the path itself connects this line to the missing
// build, which is exactly what the corroboration has to recognize.
const fs = require("fs");
const path = require("path");

const artifact = path.join(__dirname, "dist", "index.js");
if (!fs.existsSync(artifact)) {
  throw new Error(`${artifact} is missing. Run \`npm run build\` before the tests.`);
}

console.log("needs-build test passed");
