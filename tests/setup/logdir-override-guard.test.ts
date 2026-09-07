/**
 * Structural guard (Orchestrator decision D-017) for the same
 * `ShellCheckOptions.logDir` contract as
 * `tests/setup/no-real-home-writes.globalSetup.ts`, but proactive instead
 * of reactive: that global setup only catches a missing `logDir` override
 * AFTER it has already written into the real
 * `~/.agent-preflight/logs` during a test run. This guard instead
 * statically scans every `runPreflight(`/`runShellCheck(` call site under
 * `tests/` (task a53ff28e) and fails at the call site, naming file:line,
 * before the suite ever runs a check.
 *
 * A call is accepted when its options argument:
 *   - is an object literal (or `it.each` reference) that carries a
 *     `logDir` property (literal or shorthand), directly or through a
 *     `...spread` of another object literal that itself carries one
 *     (resolved recursively through variable declarations); or
 *   - is an identifier whose declaration is such an object literal, or
 *     which is later mutated with `<identifier>.logDir = ...` anywhere in
 *     the same file, resolved through the TypeScript checker's own symbol
 *     binding so two different `it()` blocks that both happen to name
 *     their local variable `config` are never confused with each other
 *     (this is why the guard type-checks the tests project rather than
 *     doing a plain textual scan); or
 *   - sits inside a test whose enclosing `it`/`test` callback contains an
 *     opt-out comment `// logdir-guard: <reason>` (the reason is
 *     mandatory and must sit on the same line: a bare `logdir-guard:` or a
 *     punctuation-only reason does not count), for a call that
 *     genuinely cannot reach `persistFailureOutput` (e.g. every
 *     lint/typecheck/test/audit/custom check toggle is `false`, or the
 *     check kind in question, such as gitState/commitConvention/
 *     secretDetection/tdd, never routes through `runShellCheck` at all).
 *
 * The opt-out comment is deliberately not a rubber stamp: every use of it
 * in this change names, in the same comment, the specific reason the call
 * cannot reach the real log directory, and a reviewer can grep for
 * `logdir-guard:` to audit every exemption at once.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

const TESTS_ROOT = path.resolve(__dirname, "..");
const GUARD_COMMENT = "logdir-guard:";
/** The opt-out counts only when the comment names a reason: at least one
 * word character after the colon, on the same line as the token (a reason on
 * the next line does not count). A bare `// logdir-guard:` or a
 * punctuation-only "reason" is a violation, so the exemption cannot be
 * silenced without saying why. The check is syntactic; it cannot judge
 * whether the stated reason is true, that is what the grep audit is for. */
const GUARD_COMMENT_WITH_REASON = /logdir-guard:[^\n]*\w/;
const TARGET_CALLS = new Set(["runPreflight", "runShellCheck"]);

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function resolveToObjectLiteral(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set()
): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) {
    const symbol = checker.getSymbolAtLocation(expr);
    const decl = symbol?.valueDeclaration;
    if (decl && !seen.has(decl) && ts.isVariableDeclaration(decl) && decl.initializer) {
      seen.add(decl);
      return resolveToObjectLiteral(decl.initializer, checker, seen);
    }
  }
  return undefined;
}

function objectLiteralHasLogDir(
  obj: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set()
): boolean {
  if (seen.has(obj)) return false;
  seen.add(obj);
  for (const prop of obj.properties) {
    if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      prop.name.getText() === "logDir"
    ) {
      return true;
    }
    if (ts.isSpreadAssignment(prop)) {
      const resolved = resolveToObjectLiteral(prop.expression, checker, seen);
      if (resolved && objectLiteralHasLogDir(resolved, checker, seen)) return true;
    }
  }
  return false;
}

/** True when `<identifier>.logDir = ...` appears anywhere the identifier's
 * own binding (per the checker's symbol resolution, so shadowed `config`
 * locals in other `it()` blocks are never mixed up) is referenced. */
function hasLaterLogDirAssignment(
  ident: ts.Identifier,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): boolean {
  const symbol = checker.getSymbolAtLocation(ident);
  if (!symbol) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === ident.text) {
      if (checker.getSymbolAtLocation(node) === symbol) {
        const parent = node.parent;
        if (
          parent &&
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === "logDir"
        ) {
          const grandParent = parent.parent;
          if (
            grandParent &&
            ts.isBinaryExpression(grandParent) &&
            grandParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            grandParent.left === parent
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function argSatisfiesLogDir(
  arg: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): boolean {
  if (ts.isObjectLiteralExpression(arg)) {
    return objectLiteralHasLogDir(arg, checker);
  }
  if (ts.isIdentifier(arg)) {
    const symbol = checker.getSymbolAtLocation(arg);
    const decl = symbol?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const resolved = resolveToObjectLiteral(decl.initializer, checker);
      if (resolved && objectLiteralHasLogDir(resolved, checker)) return true;
    }
    return hasLaterLogDirAssignment(arg, sourceFile, checker);
  }
  return false;
}

function enclosingFunctionText(node: ts.Node, sourceFile: ts.SourceFile): string {
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isFunctionLike(cur)) {
    cur = cur.parent;
  }
  return (cur ?? sourceFile).getFullText(sourceFile);
}

function scanProgram(program: ts.Program, filePaths: string[]): Violation[] {
  const checker = program.getTypeChecker();
  const violations: Violation[] = [];

  for (const filePath of filePaths) {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) continue;

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        TARGET_CALLS.has(node.expression.text)
      ) {
        const calleeName = node.expression.text;
        const arg = calleeName === "runPreflight" ? node.arguments[1] : node.arguments[0];

        const satisfied = !!arg && argSatisfiesLogDir(arg, sourceFile, checker);
        const optedOut = GUARD_COMMENT_WITH_REASON.test(enclosingFunctionText(node, sourceFile));

        if (!satisfied && !optedOut) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            file: path.relative(TESTS_ROOT, filePath),
            line: line + 1,
            snippet: node.getText(sourceFile).split("\n")[0].trim().slice(0, 100),
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

function scanFiles(filePaths: string[]): Violation[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noResolve: true,
    skipLibCheck: true,
    noEmit: true,
    strict: false,
  };
  const program = ts.createProgram(filePaths, compilerOptions);
  return scanProgram(program, filePaths);
}

describe("logDir override guard (structural, Orchestrator D-017)", () => {
  it("finds no runPreflight()/runShellCheck() call under tests/ missing a logDir override or opt-out", () => {
    const files = collectTsFiles(TESTS_ROOT).filter((f) => f !== __filename);
    const violations = scanFiles(files);

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line}  ${v.snippet}`)
        .join("\n");
      throw new Error(
        `${violations.length} call(s) reach runPreflight()/runShellCheck() without an explicit ` +
          `logDir override or a '// ${GUARD_COMMENT}' opt-out comment naming why they can't reach ` +
          `persistFailureOutput. A failing check without logDir writes into the real ` +
          `~/.agent-preflight/logs (see the ShellCheckOptions.logDir docblock in ` +
          `src/checks/shared.ts):\n${report}`
      );
    }

    expect(violations).toHaveLength(0);
  });

  it("self-check: flags a runPreflight() call whose config object has no logDir and no opt-out", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "logdir-guard-fixture-"));
    const fixturePath = path.join(fixtureDir, "violating.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          "import { it } from 'vitest';",
          "import { runPreflight } from '../src/runner.js';",
          "",
          "it('missing logDir', async () => {",
          "  const config = { checks: { lint: true } };",
          "  const result = await runPreflight('.', config);",
          "});",
        ].join("\n")
      );

      const violations = scanFiles([fixturePath]);

      expect(violations).toHaveLength(1);
      expect(violations[0].snippet).toContain("runPreflight");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("self-check: does NOT flag the same call once a logDir property is added", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "logdir-guard-fixture-ok-"));
    const fixturePath = path.join(fixtureDir, "fixed.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          "import { it } from 'vitest';",
          "import { runPreflight } from '../src/runner.js';",
          "",
          "it('has logDir', async () => {",
          "  const config = { checks: { lint: true }, logDir: '/tmp/x' };",
          "  const result = await runPreflight('.', config);",
          "});",
        ].join("\n")
      );

      const violations = scanFiles([fixturePath]);

      expect(violations).toHaveLength(0);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("self-check: does NOT flag a call carrying a same-line-scope '// logdir-guard:' opt-out comment", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "logdir-guard-fixture-optout-"));
    const fixturePath = path.join(fixtureDir, "optout.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          "import { it } from 'vitest';",
          "import { runPreflight } from '../src/runner.js';",
          "",
          "it('opted out', async () => {",
          "  const config = { checks: { lint: false } };",
          "  // logdir-guard: lint is false, never reaches persistFailureOutput",
          "  const result = await runPreflight('.', config);",
          "});",
        ].join("\n")
      );

      const violations = scanFiles([fixturePath]);

      expect(violations).toHaveLength(0);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("self-check: still flags a call whose '// logdir-guard:' opt-out names no reason", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "logdir-guard-fixture-noreason-"));
    const fixturePath = path.join(fixtureDir, "noreason.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          "import { it } from 'vitest';",
          "import { runPreflight } from '../src/runner.js';",
          "",
          "it('empty reason', async () => {",
          "  const config = { checks: { lint: true } };",
          "  // logdir-guard:",
          "  const result = await runPreflight('.', config);",
          "});",
        ].join("\n")
      );

      const violations = scanFiles([fixturePath]);

      expect(violations).toHaveLength(1);
      expect(violations[0].file).toContain("noreason.test.ts");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("self-check: still flags a call whose '// logdir-guard:' opt-out is punctuation only or puts the reason on the next line", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "logdir-guard-fixture-weakreason-"));
    const fixturePath = path.join(fixtureDir, "weakreason.test.ts");
    try {
      fs.writeFileSync(
        fixturePath,
        [
          "import { it } from 'vitest';",
          "import { runPreflight } from '../src/runner.js';",
          "",
          "it('punctuation only', async () => {",
          "  const config = { checks: { lint: true } };",
          "  // logdir-guard: -",
          "  const result = await runPreflight('.', config);",
          "});",
          "",
          "it('reason on the next line', async () => {",
          "  const config = { checks: { lint: true } };",
          "  // logdir-guard:",
          "  // lint never reaches persistFailureOutput here",
          "  const result = await runPreflight('.', config);",
          "});",
        ].join("\n")
      );

      const violations = scanFiles([fixturePath]);

      expect(violations).toHaveLength(2);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
