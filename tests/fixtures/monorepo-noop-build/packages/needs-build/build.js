// A build script that exits 0 without producing anything: the repo says it
// built, the artifacts are still missing. After such a build, a test failure
// naming those artifacts is a real break -- telling the operator to run the
// build again would be a dead end.
console.log("nothing to build (fixture)");
