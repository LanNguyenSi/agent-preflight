/**
 * Tests for src/checks/actFlags.ts: refusal of repo-supplied act flags that turn
 * the leading --dryrun into step execution. The spellings below were measured
 * against act 0.2.89 (see docs/checks.md); the accepted cases pin that a
 * container platform mapping and a redundant true dry-run flag stay usable.
 */
import { describe, expect, it } from "vitest";
import { findUnsafeActFlag } from "../src/checks/actFlags.js";

describe("findUnsafeActFlag: self-hosted platform mappings", () => {
  it.each<[string, string[]]>([
    ["-P with a separate value", ["-P", "ubuntu-latest=-self-hosted"]],
    ["--platform with a separate value", ["--platform", "ubuntu-22.04=-self-hosted"]],
    ["--platform=value", ["--platform=ubuntu-22.04=-self-hosted"]],
    ["-P=value", ["-P=ubuntu-22.04=-self-hosted"]],
    ["-Pvalue attached", ["-Pubuntu-22.04=-self-hosted"]],
    ["a short cluster ending in -P", ["-bP", "ubuntu-22.04=-self-hosted"]],
    ["a cluster with -P and an attached value", ["-bPubuntu-22.04=-self-hosted"]],
    ["upper-case value", ["-P", "ubuntu-latest=-SELF-HOSTED"]],
    ["any label", ["-P", "my-custom-label=-self-hosted"]],
    ["a later entry after harmless flags", ["--pull=false", "--platform", "ubuntu-latest=img:1", "-P", "x=-self-hosted"]],
    ["a value token after -P that looks like a flag", ["-P", "-self-hosted"]],
  ])("refuses %s", (_label, flags) => {
    const message = findUnsafeActFlag(flags);
    expect(message).toBeDefined();
    expect(message).toContain("CI simulation refused");
    expect(message).toContain("self-hosted");
  });

  it("names the offending entry in the message", () => {
    const message = findUnsafeActFlag(["-P", "ubuntu-latest=-self-hosted"]);
    expect(message).toContain('"-P ubuntu-latest=-self-hosted"');
  });
});

describe("findUnsafeActFlag: dry-run overrides", () => {
  it.each(["false", "0", "f", "F", "FALSE", "False", "no", ""])("refuses --dryrun=%j", (value) => {
    const message = findUnsafeActFlag([`--dryrun=${value}`]);
    expect(message).toContain("CI simulation refused");
    expect(message).toContain("--dryrun");
  });

  it.each([["-n=false"], ["-n=0"], ["-bn=false"], ["-gbn=0"]])("refuses the short spelling %s", (flag) => {
    expect(findUnsafeActFlag([flag])).toContain("--dryrun");
  });

  it("refuses an override placed after container platform flags", () => {
    const flags = ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest", "--dryrun=false"];
    expect(findUnsafeActFlag(flags)).toContain('"--dryrun=false"');
  });
});

describe("findUnsafeActFlag: accepted flags", () => {
  it.each<[string, string[]]>([
    ["no flags", []],
    ["the default container platform", ["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"]],
    ["-P with a container image", ["-P", "ubuntu-22.04=node:22-slim"]],
    ["several container mappings", ["-P", "a=img:1", "--platform=b=img:2", "-Pc=img:3"]],
    ["unrelated flags", ["--pull=false", "--container-architecture", "linux/amd64", "-j", "build"]],
    ["a redundant true dry-run", ["--dryrun=true", "--dryrun=1", "-n=true", "--dryrun", "-n"]],
    ["a cluster whose -n is not followed by a value", ["-nb=false"]],
    ["--dryrun with a separate token (act reads it as an event name and runs nothing)", ["--dryrun", "false"]],
    ["an image whose name only contains self-hosted", ["-P", "ubuntu-latest=self-hosted-runner:1"]],
    ["the string self-hosted as the value of another flag", ["--env", "RUNNER=-self-hosted"]],
  ])("accepts %s", (_label, flags) => {
    expect(findUnsafeActFlag(flags)).toBeUndefined();
  });
});
