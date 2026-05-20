import fs from "fs";
import path from "path";
import { execa } from "execa";
import { CheckResult, PreflightConfig } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}["']?(?!.*(?:your_|example|placeholder|here|xxx|todo|dummy))/i,
  /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["'](?!.*(?:your_|example|placeholder|here|xxx))/i,
  /(?:secret|token)\s*[:=]\s*["'][a-zA-Z0-9_-]{20,}["'](?!.*(?:your_|example|placeholder|here|xxx))/i,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];

// Placeholder patterns that indicate example/template values (not real secrets)
const PLACEHOLDER_PATTERNS = [
  /your_[a-z_]+_here/i,
  /your_[a-z_]+_key/i,
  /example[_-]?key/i,
  /placeholder/i,
  /<your[_\s]/i,
];

// Inline suppression marker (the detect-secrets convention). Comment-style
// agnostic: `# pragma: allowlist secret`, `// pragma: allowlist secret`,
// `<!-- pragma: allowlist secret -->` all work — the line just has to
// contain the phrase. A line carrying it is skipped entirely.
const ALLOWLIST_PRAGMA = /pragma:\s*allowlist\s+secret/i;

const IGNORE_FILES = [".env.example", ".env.sample", ".env.template", "*.test.ts", "*.spec.ts"];

// Framework build / cache dirs (added 2026-05-18): bundlers emit hashed
// identifiers that match the SECRET_PATTERNS heuristics (notably
// `secret/token = "<long hash>"`), producing false positives that block
// preflight on every Next.js / Nuxt / SvelteKit / Gatsby / Parcel /
// Turborepo project. These dirs are always gitignored and rebuildable,
// so a secret that only lives inside them never reaches the remote —
// which is the contract this gate is protecting. (A `NEXT_PUBLIC_*` or
// SvelteKit `PUBLIC_*` value baked into a bundle is a separate concern,
// not a leak prevented by detecting it in the gitignored build output.)
// `.cache` is intentionally broad — Gatsby, Parcel, Hugo, and various
// per-tool caches all live there; all are rebuildable.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".venv", "venv", "test_venv", "env",
  "__pycache__", "vendor", "site-packages", ".tox", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".cache", ".parcel-cache", ".turbo",
]);

interface Finding {
  /** Repo-root-relative path, always forward-slash separated. */
  file: string;
  /** 1-based line number of the matching line. */
  line: number;
}

/**
 * Secret detection with git-aware severity (harness/0dce3880 follow-up,
 * agent-tasks 6c717d8d). A finding is a hard blocker (`fail`) only when
 * the secret can actually reach the remote:
 *
 *   - Not a git repository (or git unavailable): the git→remote leak
 *     model does not apply, so every finding is a non-blocking `warn`.
 *   - A `.md` file: documentation example tokens are overwhelmingly
 *     placeholders, so a hit there is `warn`, never `fail`.
 *   - A file that is gitignored AND untracked: it cannot be pushed, so
 *     `warn`. (`git check-ignore` without `--no-index` reports exactly
 *     this set — a tracked file is never listed even if a rule matches.)
 *   - Anything else (tracked, or untracked-but-not-ignored): `fail`.
 *
 * Findings matching `config.secretAllowlist` or carrying an inline
 * `pragma: allowlist secret` comment are suppressed entirely.
 */
export async function runSecretDetection(
  repoPath: string,
  config: PreflightConfig = {},
): Promise<CheckSetResult> {
  const start = Date.now();
  const rawFindings: Finding[] = [];
  const limitations: string[] = ["secret detection uses pattern matching; not exhaustive"];

  scanDir(repoPath, repoPath, rawFindings);

  const allowlist = config.secretAllowlist ?? [];
  const findings = rawFindings.filter((f) => !matchesAllowlist(f, allowlist));

  // `git check-ignore` over just the finding files (not the whole tree).
  const uniqueFiles = [...new Set(findings.map((f) => f.file))];
  const { gitAvailable, ignoredUntracked } = await classifyIgnored(repoPath, uniqueFiles);
  if (findings.length > 0 && !gitAvailable) {
    limitations.push(
      "secret-detection: not a git repository (or git unavailable); findings reported as non-blocking warnings",
    );
  }

  const blocking: Finding[] = [];
  const warning: Finding[] = [];
  for (const f of findings) {
    if (!gitAvailable) {
      warning.push(f);
    } else if (f.file.toLowerCase().endsWith(".md")) {
      warning.push(f);
    } else if (ignoredUntracked.has(f.file)) {
      warning.push(f);
    } else {
      // Tracked, or untracked-but-not-ignored: it can reach the remote.
      blocking.push(f);
    }
  }

  const status: CheckResult["status"] =
    blocking.length > 0 ? "fail" : warning.length > 0 ? "warn" : "pass";

  let message: string | undefined;
  if (blocking.length > 0) {
    message = `${blocking.length} potential secret(s) in tracked / committable file(s)`;
    if (warning.length > 0) {
      message += ` (+${warning.length} non-blocking)`;
    }
  } else if (warning.length > 0) {
    message = `${warning.length} potential secret(s) in non-blocking location(s) (gitignored, docs, or non-git)`;
  }

  const details = [
    ...blocking.map((f) => `${f.file}:${f.line}`),
    ...warning.map((f) => `${f.file}:${f.line} (non-blocking)`),
  ].slice(0, 10);

  return {
    checks: [{
      name: "secret-detection",
      kind: "secret-detection",
      status,
      message,
      details,
      durationMs: Date.now() - start,
      confidenceContribution: 0.1,
    }],
    limitations,
  };
}

/**
 * Resolve which of `relFiles` are gitignored-and-untracked. `git
 * check-ignore` (without `--no-index`) lists a path only when an ignore
 * rule excludes it AND it is not already in the index, which is exactly
 * the "cannot leak via git" set. A 128 exit (not a repo / fatal git
 * error) or a missing `git` binary yields `gitAvailable: false`, and the
 * caller then fails safe by treating every finding as blocking-eligible.
 */
async function classifyIgnored(
  repoPath: string,
  relFiles: string[],
): Promise<{ gitAvailable: boolean; ignoredUntracked: Set<string> }> {
  if (relFiles.length === 0) return { gitAvailable: true, ignoredUntracked: new Set() };
  try {
    const res = await execa("git", ["check-ignore", "--stdin"], {
      cwd: repoPath,
      input: relFiles.join("\n"),
      reject: false,
    });
    // 0 = at least one path ignored, 1 = none ignored — both are a
    // healthy repo. Anything else (128 = not a repo / fatal) is "unknown".
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      return { gitAvailable: false, ignoredUntracked: new Set() };
    }
    const ignored = new Set(
      res.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    );
    return { gitAvailable: true, ignoredUntracked: ignored };
  } catch {
    // git binary missing (ENOENT) or spawn failure.
    return { gitAvailable: false, ignoredUntracked: new Set() };
  }
}

/**
 * Does a finding match an operator-supplied `secretAllowlist` entry?
 * An entry matches when it equals the finding's `path`, equals
 * `path:line`, or is a `*`-glob matching either. Allowlisted findings
 * are dropped before severity classification — the operator has
 * reviewed them.
 */
function matchesAllowlist(f: Finding, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const fileLine = `${f.file}:${f.line}`;
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (entry === f.file || entry === fileLine) return true;
    if (entry.includes("*")) {
      const re = globToRegExp(entry);
      if (re.test(f.file) || re.test(fileLine)) return true;
    }
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function scanDir(dir: string, root: string, findings: Finding[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // skip directories we can't read (permission denied etc.)
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, root, findings);
    } else if (entry.isFile() && isTextFile(entry.name) && !isIgnored(entry.name)) {
      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue; // ignore read errors
      }
      // forward-slash relative path so it lines up with `git check-ignore`
      // output and with operator-written allowlist entries.
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Inline suppression: a line carrying the pragma is skipped.
        if (ALLOWLIST_PRAGMA.test(line)) continue;
        for (const pattern of SECRET_PATTERNS) {
          const match = line.match(pattern);
          const matchText = match ? match[0] : "";
          if (match && !PLACEHOLDER_PATTERNS.some((p) => p.test(matchText))) {
            findings.push({ file: relPath, line: i + 1 });
            break; // one finding per line is enough
          }
        }
      }
    }
  }
}

function isTextFile(name: string): boolean {
  return /\.(ts|js|json|env|yaml|yml|toml|py|sh|md)$/.test(name);
}

function isIgnored(name: string): boolean {
  return IGNORE_FILES.some(p => p.includes("*") ? name.endsWith(p.replace("*", "")) : name === p);
}
