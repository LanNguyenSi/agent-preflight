// Loads the declared `types` artifact, which the build never emits. Unbuilt
// this is indistinguishable from "run the build first"; after a build the
// populated dist/ is what says the package is built and this file is not
// coming.
require("./dist/types/index.d.ts");
