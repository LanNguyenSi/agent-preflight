// This workspace has everything the unbuilt one next to it has: its own build
// script, a declared artifact that is missing, and a `Cannot find module`
// failure. The only difference is WHERE the missing path points -- at its own
// source tree, not at its build output -- so only the anchored corroboration
// separates the two, and this one must stay a blocker.
require("./src/helpers.js");
