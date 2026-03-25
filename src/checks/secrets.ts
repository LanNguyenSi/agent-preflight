import fs from "fs";
import path from "path";
import { CheckResult } from "../types.js";

interface CheckSetResult { checks: CheckResult[]; limitations: string[]; }

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}["']?(?!.*(?:your_|example|placeholder|here|xxx|todo|dummy))/i,
  /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["'](?!.*(?:your_|example|placeholder|here|xxx))/i,
  /(?:secret|token)\s*[:=]\s*["'][a-zA-Z0-9_\-]{20,}["'](?!.*(?:your_|example|placeholder|here|xxx))/i,
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

const IGNORE_FILES = [".env", ".env.local", ".env.example", ".env.test", "*.test.ts", "*.spec.ts"];

export async function runSecretDetection(repoPath: string): Promise<CheckSetResult> {
  const start = Date.now();
  const findings: string[] = [];
  const limitations: string[] = ["secret detection uses pattern matching; not exhaustive"];

  scanDir(repoPath, repoPath, findings);

  return {
    checks: [{
      name: "secret-detection",
      kind: "secret-detection",
      status: findings.length > 0 ? "fail" : "pass",
      message: findings.length > 0 ? `Potential secrets found in ${findings.length} location(s)` : undefined,
      details: findings.slice(0, 5),
      durationMs: Date.now() - start,
      confidenceContribution: 0.1,
    }],
    limitations,
  };
}

function scanDir(dir: string, root: string, findings: string[]): void {
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__"]);
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
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.test(content)) {
            // Skip if the match looks like a placeholder/example value
            const match = content.match(pattern);
            const matchText = match ? match[0] : "";
            const isPlaceholder = PLACEHOLDER_PATTERNS.some(p => p.test(matchText));
            if (!isPlaceholder) {
              findings.push(path.relative(root, fullPath));
              break;
            }
          }
        }
      } catch {}
    }
  }
}

function isTextFile(name: string): boolean {
  return /\.(ts|js|json|env|yaml|yml|toml|py|sh|md)$/.test(name);
}

function isIgnored(name: string): boolean {
  return IGNORE_FILES.some(p => p.includes("*") ? name.endsWith(p.replace("*", "")) : name === p);
}
