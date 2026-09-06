// The real build output is lib/ (the tsconfig says so, in a form that cannot
// be parsed as JSON), so the artifact the precondition believes is missing --
// the dist/ fallback -- is not the directory this failure is about. The
// failing path must not be read as evidence for the fallback artifact.
require("./lib/index.js");
