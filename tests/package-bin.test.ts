import { describe, expect, it } from "vitest";
import packageJson from "../package.json";

describe("npm executable map", () => {
  it("exposes the package-name CLI alias and the existing executables", () => {
    expect(packageJson.bin).toEqual({
      "agent-preflight": "dist/cli.js",
      preflight: "dist/cli.js",
      "preflight-mcp": "dist/mcp.js",
    });
  });
});
