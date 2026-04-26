import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Single source of truth for the package version.
 *
 * Resolved at module-load by reading `package.json` at the package
 * root. Layout assumption (stable across `tsc` and `npm install -g`):
 *   <pkg-root>/package.json   ← the file we read
 *   <pkg-root>/dist/version.js ← __dirname after compile
 *   <pkg-root>/src/version.ts  ← __dirname when run via vitest / ts-node
 *
 * Both layouts have package.json exactly one directory up from
 * __dirname, so a single `join(__dirname, '..', 'package.json')`
 * works for unit tests, dev runs, and the published binary.
 */
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

export const VERSION: string = pkg.version;
