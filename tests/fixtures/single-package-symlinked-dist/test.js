// Loads the declared entry point through the symlinked dist/. In an unbuilt
// checkout Node reports `Cannot find module './dist/index.js'`, whose path
// canonicalizes into lib/ while the declaration still says dist/.
require("./dist/index.js");
