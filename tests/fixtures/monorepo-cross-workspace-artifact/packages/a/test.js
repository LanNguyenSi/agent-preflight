// Workspace `a` is unbuilt and has its own build script, so its precondition
// holds -- but the path its failure names belongs to workspace `b`. Another
// package's artifact is that package's problem: it says nothing about whether
// `a` was built, so `a` must stay a blocker.
require("../b/dist/index.js");
