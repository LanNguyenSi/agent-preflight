// A JS-only build for a package whose declarations live in a NESTED directory:
// it emits dist/index.js and never emits dist/types/index.d.ts. After it runs,
// dist/ holds the build while dist/types/ does not exist at all, so the missing
// artifact's own directory says "unbuilt" while the package plainly is not.
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.js"), "module.exports = {};\n");
