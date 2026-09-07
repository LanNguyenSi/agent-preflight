import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import { expandLeadingTilde } from "../src/pathUtils";

/**
 * Unit coverage for `expandLeadingTilde`'s documented edges (task 2e8bcc7e,
 * review round 2 missing test 3): the docblock claims a bare `~` without a
 * trailing slash, an already-absolute value, and a relative value without a
 * tilde all pass through unchanged. Only the `~/`-prefixed case is exercised
 * indirectly elsewhere (runner.test.ts's tilde-expansion case, shared-*
 * tests); these pin the pass-through edges directly.
 */
describe("expandLeadingTilde", () => {
  it("expands a leading '~/' to os.homedir()", () => {
    expect(expandLeadingTilde("~/logs")).toBe(path.join(os.homedir(), "logs"));
  });

  it("leaves a bare '~' with no trailing slash unchanged", () => {
    expect(expandLeadingTilde("~")).toBe("~");
  });

  it("leaves an already-absolute value unchanged", () => {
    expect(expandLeadingTilde("/var/tmp/logs")).toBe("/var/tmp/logs");
  });

  it("leaves a relative value without a tilde unchanged", () => {
    expect(expandLeadingTilde("relative/logs")).toBe("relative/logs");
  });
});
