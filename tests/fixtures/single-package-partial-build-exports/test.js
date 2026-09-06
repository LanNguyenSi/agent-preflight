// A genuine regression inside the built dist/index.js: the stack frame names a
// file that IS on disk, in the same dist/ the never-emitted `./extra` subpath
// would have lived in.
require("./dist/index.js").f();
