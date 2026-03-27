import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig } from "../src/config.js";
import { runPreflight } from "../src/runner.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeExecutable(dir: string, name: string, body: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  return filePath;
}

afterEach(() => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("profile configuration", () => {
  it("merges nested config keys from .preflight.json", () => {
    const repoPath = makeTempDir("preflight-config-");
    fs.writeFileSync(
      path.join(repoPath, ".preflight.json"),
      JSON.stringify({
        workingDir: "apps/api",
        checks: {
          audit: false,
        },
        commands: {
          test: ["true"],
        },
      })
    );

    const config = loadConfig(repoPath);

    expect(config.workingDir).toBe("apps/api");
    expect(config.checks?.audit).toBe(false);
    expect(config.checks?.gitState).toBe(true);
    expect(config.checks?.lint).toBe(true);
    expect(config.commands?.test).toEqual(["true"]);
    expect(config.actFlags).toEqual(["--platform", "ubuntu-latest=catthehacker/ubuntu:act-latest"]);
    expect(config.sandbox?.aptPackages).toEqual([]);
  });

  it("merges sandbox package overrides from .preflight.json", () => {
    const repoPath = makeTempDir("preflight-sandbox-config-");
    fs.writeFileSync(
      path.join(repoPath, ".preflight.json"),
      JSON.stringify({
        sandbox: {
          aptPackages: ["php-intl"],
          pipPackages: ["bandit"],
        },
      })
    );

    const config = loadConfig(repoPath);

    expect(config.sandbox?.aptPackages).toEqual(["php-intl"]);
    expect(config.sandbox?.pipPackages).toEqual(["bandit"]);
  });

  it("runs configured test commands", async () => {
    const repoPath = makeTempDir("preflight-test-command-");

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: true,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      commands: {
        test: ["true"],
      },
    });

    expect(result.blockers).toHaveLength(0);
    expect(result.checks.some((check) => check.kind === "test" && check.status === "pass")).toBe(true);
  });

  it("runs npm ci as a setup step before Node checks", async () => {
    const repoPath = makeTempDir("preflight-node-setup-");
    const binDir = path.join(repoPath, ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    process.env.PATH = `${binDir}:${originalPath}`;

    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({
        name: "node-app",
        version: "1.0.0",
        scripts: {
          test: "echo ok",
        },
      })
    );
    fs.writeFileSync(path.join(repoPath, "package-lock.json"), "{}");

    makeExecutable(
      binDir,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ci" ]]; then
  mkdir -p node_modules/.bin
  touch node_modules/.install-complete
  exit 0
fi
if [[ "$1" == "run" && "$2" == "test" ]]; then
  [[ -f node_modules/.install-complete ]]
  exit 0
fi
exit 1
`
    );

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: true,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    });

    expect(fs.existsSync(path.join(repoPath, "node_modules", ".install-complete"))).toBe(true);
    expect(result.checks.find((check) => check.name === "npm-test")?.status).toBe("pass");
  });

  it("resolves workingDir before running checks", async () => {
    const repoPath = makeTempDir("preflight-working-dir-");
    const workingDir = path.join(repoPath, "apps", "api");
    fs.mkdirSync(workingDir, { recursive: true });

    const result = await runPreflight(repoPath, {
      workingDir: "apps/api",
      checks: {
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      customChecks: [
        {
          name: "cwd-check",
          command: `[ "$(pwd)" = "${workingDir}" ]`,
        },
      ],
    });

    expect(result.blockers).toHaveLength(0);
    expect(result.checks.find((check) => check.name === "cwd-check")?.status).toBe("pass");
  });

  it("adds a workingDir hint when package.json only exists in a subdirectory", async () => {
    const repoPath = makeTempDir("preflight-monorepo-hint-");
    fs.mkdirSync(path.join(repoPath, "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "cli", "package.json"),
      JSON.stringify({ name: "cli", version: "1.0.0" })
    );

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    });

    expect(result.limitations).toContain("package.json found in cli/ - set workingDir: cli in .preflight.json");
  });

  it("runs composer install as a setup step before PHP checks", async () => {
    const repoPath = makeTempDir("preflight-composer-setup-");
    const binDir = path.join(repoPath, ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    process.env.PATH = `${binDir}:${originalPath}`;

    fs.writeFileSync(
      path.join(repoPath, "composer.json"),
      JSON.stringify({
        name: "example/app",
        scripts: {
          test: "phpunit",
        },
      })
    );

    makeExecutable(
      binDir,
      "composer",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "install" ]]; then
  mkdir -p vendor
  touch vendor/autoload.php
  exit 0
fi
if [[ "$1" == "run" && "$2" == "test" ]]; then
  [[ -f vendor/autoload.php ]]
  exit 0
fi
exit 1
`
    );

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: true,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    });

    expect(fs.existsSync(path.join(repoPath, "vendor", "autoload.php"))).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.checks.find((check) => check.name === "composer-test")?.status).toBe("pass");
  });

  it("creates a Python venv and uses it for Python checks", async () => {
    const repoPath = makeTempDir("preflight-python-setup-");
    const binDir = path.join(repoPath, ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    process.env.PATH = `${binDir}:${originalPath}`;

    fs.writeFileSync(path.join(repoPath, "requirements.txt"), "pytest\n");

    makeExecutable(
      binDir,
      "python3",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-m" && "$2" == "venv" ]]; then
  VENV_PATH="$3"
  mkdir -p "$VENV_PATH/bin"
  cat > "$VENV_PATH/bin/pip" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$VENV_PATH/bin/pytest" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$VENV_PATH/bin/pip" "$VENV_PATH/bin/pytest"
  exit 0
fi
exit 1
`
    );

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: true,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    });

    expect(fs.existsSync(path.join(repoPath, ".preflight-venv", "bin", "pytest"))).toBe(true);
    expect(result.checks.find((check) => check.name === "pytest")?.status).toBe("pass");
  });

  it("runs Maven setup before Java checks", async () => {
    const repoPath = makeTempDir("preflight-java-maven-setup-");
    fs.writeFileSync(path.join(repoPath, "pom.xml"), "<project />");
    fs.writeFileSync(
      path.join(repoPath, "mvnw"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"dependency:go-offline"* ]]; then
  mkdir -p target
  touch target/.setup-complete
  exit 0
fi
if [[ "$*" == *"compile"* ]]; then
  [[ -f target/.setup-complete ]]
  exit 0
fi
exit 1
`,
      { mode: 0o755 }
    );

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: true,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    });

    expect(fs.existsSync(path.join(repoPath, "target", ".setup-complete"))).toBe(true);
    expect(result.checks.find((check) => check.name === "maven-compile")?.status).toBe("pass");
  });

  it("uses tsc as a lint fallback for TypeScript repos without eslint", async () => {
    const repoPath = makeTempDir("preflight-ts-lint-fallback-");
    const binDir = path.join(repoPath, ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    process.env.PATH = `${binDir}:${originalPath}`;

    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "ts-app", version: "1.0.0" })
    );
    fs.writeFileSync(
      path.join(repoPath, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
        },
      })
    );

    makeExecutable(
      binDir,
      "npx",
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "tsc" ]]
exit 0
`
    );

    const result = await runPreflight(repoPath, {
      checks: {
        lint: true,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
    });

    expect(result.checks.find((check) => check.name === "tsc-lint-fallback")?.status).toBe("pass");
    expect(result.limitations).not.toContain("No supported Node lint command found (npm script or eslint)");
  });

  it("downgrades optional custom checks to warnings", async () => {
    const repoPath = makeTempDir("preflight-custom-warn-");

    const result = await runPreflight(repoPath, {
      checks: {
        lint: false,
        typecheck: false,
        test: false,
        audit: false,
        secretDetection: false,
        commitConvention: false,
        ciSimulation: false,
      },
      customChecks: [
        {
          name: "optional-smoke",
          command: "false",
          failOnError: false,
        },
      ],
    });

    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toContain("optional-smoke failed");
  });
});
