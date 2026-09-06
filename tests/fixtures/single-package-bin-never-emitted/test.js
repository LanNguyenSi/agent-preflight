// Loads the declared `bin`, which the build never emits. Unbuilt, this is
// indistinguishable from "run the build first"; after a build it is the
// package's own defect, and the populated dist/ is what says so.
require("./dist/cli.js");
