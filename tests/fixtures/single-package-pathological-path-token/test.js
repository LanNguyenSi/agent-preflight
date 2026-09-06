// A genuinely failing test whose output carries a pathological path-shaped
// token: 30000 segments on one `Cannot find module` line. Every path token in
// runner output is walked segment by segment, so an unbounded implementation
// aborts the whole preflight run here instead of reporting this failure.
console.error("Error: Cannot find module './" + "a/".repeat(30000) + "x.js'");
process.exit(1);
