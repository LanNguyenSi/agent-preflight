import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

describe("published executable entrypoints", () => {
  it("declares executable bins without a library main", () => {
    expect(packageJson).not.toHaveProperty("main");
    expect(packageJson.bin).toEqual({
      "agent-preflight": "dist/cli.js", preflight: "dist/cli.js", "preflight-mcp": "dist/mcp.js",
    });
  });

  it.each(Object.entries(packageJson.bin) as [string, string][])("%s prints its version with stdin closed", (_name, target) => {
    const result = spawnSync(process.execPath, [target, "--version"], {
      cwd: process.cwd(), encoding: "utf8", input: "", timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
    expect(result.stderr).toBe("");
  });
});
