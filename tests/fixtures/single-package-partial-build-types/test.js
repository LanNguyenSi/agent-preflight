// Loads the BUILT output and hits a genuine runtime bug in it. The Node stack
// frame therefore names a path inside the live dist/ (dist/index.js:2), which
// is exactly the file the build produced and the tests load.
const { add } = require("./dist/index.js");

add(1, 2);
