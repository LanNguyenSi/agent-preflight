// Same genuine bug as the single-package fixture, reached through the root's
// `--workspaces --if-present` fan-out so the failure is attributed to this
// workspace rather than to the root package.
require("./dist/index.js").render();
