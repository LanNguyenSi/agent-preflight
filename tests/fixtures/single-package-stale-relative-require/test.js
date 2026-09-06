// The everyday bug this fixture pins: a source file was renamed and one
// require was left behind. The package is unbuilt (dist/index.js is missing,
// a build script exists), so the precondition holds -- but the failure is
// about ./src/renamed-away.js, inside the package and nowhere near its build
// output, so no build would fix it and the check must stay a blocker.
require("./src/renamed-away.js");
