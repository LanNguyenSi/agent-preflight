import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { runGitStateChecks, snapshotWorktreeState } from "../src/checks/git.js";
import { defaultConfig } from "../src/config.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initGitRepo(repoPath: string): void {
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n", "utf8");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "feat: initial commit"]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("git state checks", () => {
  it("passes on a clean feature branch", async () => {
    const repoPath = makeTempDir("preflight-git-state-clean-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.limitations).toEqual([]);
    expect(result.checks.find((check) => check.name === "protected-branch")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "clean-worktree")?.status).toBe("pass");
  });

  it("warns on a protected branch", async () => {
    const repoPath = makeTempDir("preflight-git-state-protected-");
    initGitRepo(repoPath);
    git(repoPath, ["branch", "-M", "main"]);

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.checks.find((check) => check.name === "protected-branch")?.status).toBe("warn");
    expect(result.checks.find((check) => check.name === "protected-branch")?.message).toContain(
      'Repository is on protected branch "main"'
    );
  });

  it("fails when the worktree is dirty", async () => {
    const repoPath = makeTempDir("preflight-git-state-dirty-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "notes.txt"), "dirty\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.checks.find((check) => check.name === "clean-worktree")?.status).toBe("fail");
    expect(result.checks.find((check) => check.name === "clean-worktree")?.message).toBe(
      "Repository has uncommitted changes"
    );
  });

  it("returns a limitation for non-git directories", async () => {
    const repoPath = makeTempDir("preflight-git-state-non-git-");

    const result = await runGitStateChecks(repoPath, defaultConfig());

    expect(result.checks).toEqual([]);
    expect(result.limitations).toContain("Not a git repository; git state checks skipped");
  });
});

// task b16ab5d8, review round 1, findings F2-F4 and the missing-tests list:
// the failed-snapshot fallback, the rename-parsing branch, the special-path
// `-z` parsing, the ">10 paths" cap wording, and the "snapshot present but
// nothing produced" clean branch were all unpinned. `runGitStateChecks`'s
// third parameter is exercised directly here (the same entry point
// `runCleanWorktreeCheck` uses once `--setup` is enabled) rather than
// through `runPreflight`, since these are about `clean-worktree`'s own
// classification logic, not the setup wiring (already covered by
// tests/setup-clean-worktree.test.ts).
describe("clean-worktree with a pre-setup snapshot", () => {
  it("F2: falls back to the undifferentiated check and still fails on a dirty repo when the snapshot itself failed", async () => {
    const repoPath = makeTempDir("preflight-git-state-snapshot-failed-dirty-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "notes.txt"), "dirty\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig(), { paths: null });

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("Repository has uncommitted changes");
    expect(
      result.limitations.some((l) => l.toLowerCase().includes("could not snapshot the worktree"))
    ).toBe(true);
  });

  it("F2: falls back and still passes on a clean repo when the snapshot itself failed, but flags the limitation", async () => {
    const repoPath = makeTempDir("preflight-git-state-snapshot-failed-clean-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const result = await runGitStateChecks(repoPath, defaultConfig(), { paths: null });

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    expect(
      result.limitations.some((l) => l.toLowerCase().includes("could not snapshot the worktree"))
    ).toBe(true);
  });

  it("F3 (direct): snapshotWorktreeState splits a staged rename into both its old and new path", async () => {
    const repoPath = makeTempDir("preflight-git-state-rename-snapshot-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "old.txt"), "content\n", "utf8");
    git(repoPath, ["add", "old.txt"]);
    git(repoPath, ["commit", "-m", "add old.txt"]);
    git(repoPath, ["mv", "old.txt", "new.txt"]);

    const snapshot = await snapshotWorktreeState(repoPath);

    expect(snapshot.paths).not.toBeNull();
    // Both sides are recorded as separate paths, not a single "old.txt ->
    // new.txt" (or similarly garbled) string.
    expect(snapshot.paths?.has("old.txt")).toBe(true);
    expect(snapshot.paths?.has("new.txt")).toBe(true);
    expect(snapshot.paths?.has("old.txt -> new.txt")).toBe(false);
  });

  it("F3 (end-to-end): a pre-existing modification still blocks even when it later reads as the 'from' side of a rename record", async () => {
    // Deliberately the reverse order of "stage the rename before the
    // snapshot": that ordering does not actually discriminate the
    // rename-parsing branch, because the same porcelain line is parsed
    // identically at snapshot time and check time either way (split or
    // not), so both a correct and a broken parser agree. What DOES
    // discriminate it: a plain pre-existing change captured by the
    // snapshot as its own simple path, which by check time is folded into
    // a rename record's "from" field. A parser that drops the "from"
    // field (the bug review finding F3 describes -- "parsed as one path,
    // miss the snapshot") loses the only token that still matches the
    // snapshot, and the pre-existing change wrongly falls through to the
    // "--setup produced this" classification instead of blocking with
    // today's message.
    const repoPath = makeTempDir("preflight-git-state-rename-loses-identity-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "file.txt"), "content\n", "utf8");
    git(repoPath, ["add", "file.txt"]);
    git(repoPath, ["commit", "-m", "add file.txt"]);

    // Pre-existing dirt, captured by the snapshot as a plain "file.txt"
    // entry -- nothing rename-shaped yet.
    fs.writeFileSync(path.join(repoPath, "file.txt"), "changed\n", "utf8");
    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.has("file.txt")).toBe(true);

    // Now the same still-uncommitted change is renamed, so at check time
    // git reports it as a single "RM" record whose "from" path is
    // "file.txt".
    git(repoPath, ["mv", "file.txt", "renamed.txt"]);

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("fail");
    // The pre-existing-dirt message specifically -- not the
    // "--setup modified or removed tracked files" message a parser that
    // lost the "from" path would produce instead (still a `fail`, but for
    // the wrong reason, via the wrong branch).
    expect(check?.message).toBe("Repository has uncommitted changes");
  });

  it("F4: an untracked setup-produced path containing a space and a literal ' -> ' substring is named correctly, not split", async () => {
    const repoPath = makeTempDir("preflight-git-state-weird-name-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const weirdName = "weird -> name.txt";
    let weirdNameSupported = true;
    try {
      fs.writeFileSync(path.join(repoPath, weirdName), "content\n", "utf8");
    } catch {
      weirdNameSupported = false;
    }
    if (!weirdNameSupported) {
      // Some filesystems reject this character combination; nothing to
      // pin here in that case.
      return;
    }

    // Snapshot taken while the worktree is clean (the weird-named file is
    // not created yet).
    fs.rmSync(path.join(repoPath, weirdName));
    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.size).toBe(0);

    // "--setup" (simulated) produces the weird-named file.
    fs.writeFileSync(path.join(repoPath, weirdName), "content\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    const text = `${check?.message ?? ""} ${(check?.details ?? []).join(" ")} ${result.limitations.join(" ")}`;
    expect(text).toContain(weirdName);
    // A parser that (mis)treats " -> " as a rename delimiter would report
    // "weird" and "name.txt" as two separate garbled paths instead.
    expect(text).not.toContain("weird\"");
  });

  it("caps the setup-produced path list at 10 names and folds the rest into an 'and N more' tail", async () => {
    const repoPath = makeTempDir("preflight-git-state-cap-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.size).toBe(0);

    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(repoPath, `generated-${i}.txt`), "x\n", "utf8");
    }

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    const detailText = (check?.details ?? []).join(" ");
    expect(detailText).toContain(", and 2 more");
    // Exactly 10 of the 12 generated names are listed by name.
    const namedCount = Array.from({ length: 12 }, (_, i) => `generated-${i}.txt`).filter((name) =>
      detailText.includes(name)
    ).length;
    expect(namedCount).toBe(10);
  });

  it("passes with today's plain message when the snapshot is present but setup produced nothing and the worktree stayed clean", async () => {
    const repoPath = makeTempDir("preflight-git-state-snapshot-clean-noop-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.size).toBe(0);

    // Nothing changes between the snapshot and the check.
    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    expect(check?.message).toBeUndefined();
    expect(result.limitations).toEqual([]);
  });

  // task b16ab5d8, review round 3:
  it("N2: names the tracked paths in a limitations entry too, since the CLI never prints a check's own details", async () => {
    const repoPath = makeTempDir("preflight-git-state-tracked-limitation-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# test\nbuilt\n", "utf8");
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "checked-in build output"]);

    const snapshot = await snapshotWorktreeState(repoPath);

    // "--setup" (simulated) rewrites the tracked file.
    fs.writeFileSync(path.join(repoPath, "README.md"), "# test\nrebuilt\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("--setup modified or removed tracked files");
    expect(result.limitations.length).toBe(1);
    expect(result.limitations[0]).toContain("README.md");
    expect(result.limitations[0]).toContain("--setup modified or removed tracked files");
  });

  it("pins a tracked-file DELETE ('D ' or ' D') produced by --setup as reaching the tracked branch, not the untracked one", async () => {
    const repoPath = makeTempDir("preflight-git-state-tracked-delete-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);
    fs.writeFileSync(path.join(repoPath, "stale-artifact.txt"), "stale\n", "utf8");
    git(repoPath, ["add", "stale-artifact.txt"]);
    git(repoPath, ["commit", "-m", "checked-in stale artifact"]);

    const snapshot = await snapshotWorktreeState(repoPath);

    // "--setup" (simulated) removes the tracked file (a build that stops
    // producing an artifact it used to, or cleans a stale one).
    fs.rmSync(path.join(repoPath, "stale-artifact.txt"));

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("--setup modified or removed tracked files");
    const text = `${(check?.details ?? []).join(" ")} ${result.limitations.join(" ")}`;
    expect(text).toContain("stale-artifact.txt");
  });

  it("N3: a setup-produced path name containing a newline is escaped to a single line, in both details and the limitation", async () => {
    const repoPath = makeTempDir("preflight-git-state-newline-name-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const weirdName = "weird\nname.txt";
    let weirdNameSupported = true;
    try {
      fs.writeFileSync(path.join(repoPath, weirdName), "content\n", "utf8");
    } catch {
      weirdNameSupported = false;
    }
    if (!weirdNameSupported) {
      // Some filesystems reject an embedded newline; nothing to pin here
      // in that case.
      return;
    }
    fs.rmSync(path.join(repoPath, weirdName));

    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.size).toBe(0);

    fs.writeFileSync(path.join(repoPath, weirdName), "content\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    const detail = (check?.details ?? []).find((d) => d.includes("weird")) ?? "";
    expect(detail.split("\n").length).toBe(1);
    expect(detail).toContain("weird\\nname.txt");
    const limitation = result.limitations.find((l) => l.includes("weird")) ?? "";
    expect(limitation.split("\n").length).toBe(1);
    expect(limitation).toContain("weird\\nname.txt");
  });

  it("N3: a very long setup-produced path name is truncated with an ellipsis instead of growing the message unbounded", async () => {
    const repoPath = makeTempDir("preflight-git-state-long-name-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.size).toBe(0);

    // 250 'a' characters plus a short extension: long enough to exceed
    // the 200-character cap while staying under common filesystem
    // filename-length limits (255 bytes on APFS/ext4/HFS+).
    const longName = `${"a".repeat(250)}.txt`;
    fs.writeFileSync(path.join(repoPath, longName), "content\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    const detail = (check?.details ?? []).find((d) => d.includes("aaa")) ?? "";
    expect(detail).not.toContain(longName);
    expect(detail).toContain("…");
    expect(detail).toContain("a".repeat(200));
    expect(detail).not.toContain("a".repeat(201));
  });

  it("dd8258ca: a setup-produced path name containing DEL, a C1 control character (U+009B CSI) and a Unicode line separator (U+2028) is escaped, not passed through", async () => {
    const repoPath = makeTempDir("preflight-git-state-c1-name-");
    initGitRepo(repoPath);
    git(repoPath, ["checkout", "-b", "feature/example"]);

    const DEL = String.fromCharCode(0x7f);
    const CSI = String.fromCharCode(0x9b);
    const LINE_SEPARATOR = String.fromCharCode(0x2028);
    const weirdName = `weird${DEL}${CSI}${LINE_SEPARATOR}name.txt`;
    let weirdNameSupported = true;
    try {
      fs.writeFileSync(path.join(repoPath, weirdName), "content\n", "utf8");
    } catch {
      weirdNameSupported = false;
    }
    if (!weirdNameSupported) {
      // Some filesystems reject DEL/C1/line-separator bytes in a name;
      // nothing to pin here in that case.
      return;
    }
    fs.rmSync(path.join(repoPath, weirdName));

    const snapshot = await snapshotWorktreeState(repoPath);
    expect(snapshot.paths?.size).toBe(0);

    fs.writeFileSync(path.join(repoPath, weirdName), "content\n", "utf8");

    const result = await runGitStateChecks(repoPath, defaultConfig(), snapshot);

    const check = result.checks.find((c) => c.name === "clean-worktree");
    expect(check?.status).toBe("pass");
    const expectedEscaped = "weird\\u007f\\u009b\\u2028name.txt";
    const detail = (check?.details ?? []).find((d) => d.includes("weird")) ?? "";
    expect(detail).toContain(expectedEscaped);
    expect(detail).not.toContain(DEL);
    expect(detail).not.toContain(CSI);
    expect(detail).not.toContain(LINE_SEPARATOR);
    const limitation = result.limitations.find((l) => l.includes("weird")) ?? "";
    expect(limitation).toContain(expectedEscaped);
  });
});
