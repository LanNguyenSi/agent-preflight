// Loads the BUILT output and hits its genuine bug: an ENOENT on a template
// inside the live dist/ that the build never copies. Both the stale `types`
// declaration (which keeps the precondition met forever) and the ENOENT path
// (which is absent, like an unbuilt one) point at the same dist/.
require("./dist/index.js").render();
