// This workspace has NO build script of its own. The root's
// `npm run build --workspaces --if-present` skips exactly such a workspace, so
// the build it seems to promise is a no-op here and "run the build first"
// would be a dead end -- the failure has to stay a blocker naming that.
//
// The two lines printed before the failure are the message-only trap: a
// missing dependency inside this workspace's own node_modules, and a path
// belonging to the nested `w-tools` package. Both sit inside this workspace's
// directory, and neither may be quoted as this package's own observation.
const path = require("path");

console.error(
  `Error: Cannot find module '${path.join(__dirname, "node_modules", "some-lib", "dist", "index.js")}'`
);
console.error(`Error: Cannot find module '${path.join(__dirname, "tools", "dist", "index.js")}'`);

require("./dist/index.js");
