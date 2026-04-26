import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version";

const REPO_ROOT = join(__dirname, "..");
const SRC_DIR = join(REPO_ROOT, "src");

describe("VERSION", () => {
  it("matches package.json (single source of truth)", () => {
    const pkgPath = join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("looks like a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // DRY-invariant guard: lock in that no source file outside version.ts
  // ever re-introduces a hardcoded version literal. The pre-release
  // shape of this codebase had `.version("0.1.0")` baked into
  // src/cli.ts, which would have drifted silently the next time
  // someone bumped package.json. This test catches a regression by
  // grepping for `.version("X.Y.Z")` (commander's API shape) wherever
  // it appears under src/ except version.ts itself.
  it.each([["cli.ts", join(SRC_DIR, "cli.ts")]])(
    "does not re-introduce a hardcoded version literal in %s",
    (_label, filePath) => {
      const source = readFileSync(filePath, "utf-8");
      expect(source).not.toMatch(/\.version\s*\(\s*['"]\d+\.\d+\.\d+/);
    },
  );
});
