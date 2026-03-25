import { execa } from "execa";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { loadConfig } from "./config.js";
import { createProjectContext, fileExists, hasJavaProject, hasNodeProject, hasPhpProject, hasPythonProject } from "./checks/shared.js";
import { PreflightConfig } from "./types.js";

export const DEFAULT_SANDBOX_IMAGE = "agent-preflight:local";
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKERFILE_PATH = path.resolve(__dirname, "..", "Dockerfile");
const PHP_EXTENSION_PACKAGE_MAP: Record<string, string> = {
  bcmath: "php-bcmath",
  curl: "php-curl",
  dom: "php-xml",
  gd: "php-gd",
  intl: "php-intl",
  mbstring: "php-mbstring",
  mysqli: "php-mysql",
  pdo_mysql: "php-mysql",
  pdo_pgsql: "php-pgsql",
  pgsql: "php-pgsql",
  soap: "php-soap",
  sqlite3: "php-sqlite3",
  xml: "php-xml",
  xmlreader: "php-xml",
  xmlwriter: "php-xml",
  zip: "php-zip",
};

export interface SandboxCommandOptions {
  build?: boolean;
  pull?: boolean;
  print?: boolean;
  dockerSocket?: boolean;
  image?: string;
  json?: boolean;
  ciSimulation?: boolean;
  noAudit?: boolean;
  noSecrets?: boolean;
}

export interface SandboxPlan {
  workspacePath: string;
  packageRoot: string;
  image: string;
  autoBuild: boolean;
  profile: SandboxProfile;
  buildCommand?: string[];
  pullCommand?: string[];
  runCommand: string[];
}

export interface SandboxProfile {
  capabilities: string[];
  aptPackages: string[];
  pipPackages: string[];
  fingerprint: string;
  targetPath: string;
}

interface DockerRunContext {
  workspacePath: string;
  image: string;
  dockerSocket: boolean;
  tty: boolean;
  homeDir: string;
}

export async function runSandbox(
  repoPath: string | undefined,
  options: SandboxCommandOptions
): Promise<void> {
  const plan = await createSandboxPlan(repoPath, options);

  if (options.print) {
    if (plan.buildCommand) {
      console.log(formatCommand(plan.buildCommand));
    }
    if (plan.pullCommand) {
      console.log(formatCommand(plan.pullCommand));
    }
    console.log(formatCommand(plan.runCommand));
    return;
  }

  if (!commandExists("docker")) {
    throw new Error("Docker is not installed or not available in PATH.");
  }

  if (plan.buildCommand) {
    console.error(
      `[preflight][sandbox] Building image ${plan.image} for profile ${describeSandboxProfile(plan.profile)}`
    );
    await runDockerCommand(plan.buildCommand);
  }

  if (plan.pullCommand) {
    console.error(`[preflight][sandbox] Pulling image ${plan.image}`);
    await runDockerCommand(plan.pullCommand);
  }

  const result = await execa(plan.runCommand[0], plan.runCommand.slice(1), {
    stdio: "inherit",
    reject: false,
  });

  process.exit(result.exitCode ?? 1);
}

export async function createSandboxPlan(
  repoPath: string | undefined,
  options: SandboxCommandOptions
): Promise<SandboxPlan> {
  const workspacePath = resolveWorkspacePath(repoPath);
  const packageRoot = resolvePackageRoot();
  const config = loadConfig(workspacePath);
  const profile = detectSandboxProfile(workspacePath, config, options);
  const image = options.image ?? buildSandboxImageName(profile);

  if (!fs.existsSync(path.join(packageRoot, "Dockerfile"))) {
    throw new Error(`Sandbox Dockerfile not found in ${packageRoot}.`);
  }

  if (options.dockerSocket && !fs.existsSync(DOCKER_SOCKET_PATH)) {
    throw new Error(`${DOCKER_SOCKET_PATH} not found. Start Docker or omit --docker-socket.`);
  }

  const autoBuild = shouldAutoBuild({
    buildRequested: options.build === true,
    pullRequested: options.pull === true,
    printOnly: options.print === true,
    canAutoBuild: isAutoBuildCandidate(image),
    imageExists: await localImageExists(image),
  });

  return {
    workspacePath,
    packageRoot,
    image,
    autoBuild,
    profile,
    buildCommand: options.build || autoBuild ? buildDockerBuildCommand(packageRoot, image, profile) : undefined,
    pullCommand: options.pull ? ["docker", "pull", image] : undefined,
    runCommand: buildDockerRunCommand(
      {
        workspacePath,
        image,
        dockerSocket: options.dockerSocket === true,
        tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        homeDir: os.homedir(),
      },
      buildSandboxPreflightArgs(options)
    ),
  };
}

export function buildSandboxPreflightArgs(options: SandboxCommandOptions): string[] {
  const args = ["run", "/workspace"];

  if (options.json) args.push("--json");
  if (options.ciSimulation) args.push("--ci-simulation");
  if (options.noAudit) args.push("--no-audit");
  if (options.noSecrets) args.push("--no-secrets");

  return args;
}

export function buildDockerRunCommand(
  context: DockerRunContext,
  preflightArgs: string[]
): string[] {
  const containerName = `agent-preflight-${sanitizeContainerName(path.basename(context.workspacePath))}`;
  const args = ["docker", "run", "--rm", "--name", containerName];

  if (context.tty) {
    args.push("-it");
  }

  args.push("-v", `${context.workspacePath}:/workspace`, "-w", "/workspace");
  args.push(
    "-e", "GIT_CONFIG_COUNT=1",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=/workspace"
  );

  for (const [hostPath, containerPath] of getCacheMounts(context.homeDir)) {
    if (fs.existsSync(hostPath)) {
      args.push("-v", `${hostPath}:${containerPath}`);
    }
  }

  if (context.dockerSocket) {
    args.push("-v", `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}`);
  }

  args.push(context.image, ...preflightArgs);
  return args;
}

export function sanitizeContainerName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "workspace";
}

export function formatCommand(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

export function shouldAutoBuild(options: {
  buildRequested: boolean;
  pullRequested: boolean;
  printOnly: boolean;
  canAutoBuild: boolean;
  imageExists: boolean;
}): boolean {
  return (
    !options.buildRequested &&
    !options.pullRequested &&
    !options.printOnly &&
    options.canAutoBuild &&
    !options.imageExists
  );
}

export function detectSandboxProfile(
  repoPath: string,
  config: PreflightConfig,
  options: SandboxCommandOptions
): SandboxProfile {
  const targetPath = resolveTargetPath(repoPath, config);
  const context = createProjectContext(targetPath);
  const capabilities = new Set<string>();

  if (hasNodeProject(context)) capabilities.add("node");
  if (context.hasTsconfig) capabilities.add("typescript");
  if (hasPythonProject(context)) capabilities.add("python");
  if (hasPhpProject(context)) capabilities.add("php");
  if (hasJavaProject(context)) capabilities.add("java");
  if (options.ciSimulation) capabilities.add("act");
  if (isSymfonyProject(targetPath)) capabilities.add("symfony");

  const aptPackages = normalizePackages([
    ...detectPhpExtensionPackages(targetPath),
    ...(isSymfonyProject(targetPath) ? ["php-intl", "php-mbstring", "php-xml"] : []),
    ...(config.sandbox?.aptPackages ?? []),
  ]);
  const pipPackages = normalizePackages(config.sandbox?.pipPackages ?? []);
  const fingerprint = createSandboxFingerprint(capabilities, aptPackages, pipPackages);

  return {
    capabilities: [...capabilities].sort(),
    aptPackages,
    pipPackages,
    fingerprint,
    targetPath,
  };
}

export function buildSandboxImageName(profile: SandboxProfile): string {
  if (profile.capabilities.length === 0 && profile.aptPackages.length === 0 && profile.pipPackages.length === 0) {
    return DEFAULT_SANDBOX_IMAGE;
  }

  const capabilitySlug = profile.capabilities.join("-").slice(0, 40).replace(/^-+|-+$/g, "");
  const suffix = capabilitySlug.length > 0
    ? `${capabilitySlug}-${profile.fingerprint.slice(0, 12)}`
    : profile.fingerprint.slice(0, 12);

  return `${DEFAULT_SANDBOX_IMAGE}-${suffix}`;
}

export function buildDockerBuildCommand(packageRoot: string, image: string, profile: SandboxProfile): string[] {
  return [
    "docker",
    "build",
    "-t",
    image,
    "--build-arg",
    `SANDBOX_PROFILE=${profile.fingerprint}`,
    "--build-arg",
    `EXTRA_APT_PACKAGES=${profile.aptPackages.join(" ")}`,
    "--build-arg",
    `EXTRA_PIP_PACKAGES=${profile.pipPackages.join(" ")}`,
    packageRoot,
  ];
}

function resolvePackageRoot(): string {
  return path.resolve(__dirname, "..");
}

function resolveWorkspacePath(repoPath: string | undefined): string {
  const resolvedPath = path.resolve(repoPath ?? process.cwd());
  if (repoPath) {
    return resolvedPath;
  }

  return resolveGitRoot(resolvedPath) ?? resolvedPath;
}

function resolveGitRoot(startPath: string): string | null {
  const result = spawnSync("git", ["-C", startPath, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return null;
  }

  const gitRoot = result.stdout.trim();
  return gitRoot.length > 0 ? gitRoot : null;
}

async function localImageExists(image: string): Promise<boolean> {
  if (!commandExists("docker")) {
    return false;
  }

  const { exitCode } = await execa("docker", ["image", "inspect", image], {
    reject: false,
    stdio: "ignore",
  });

  return exitCode === 0;
}

async function runDockerCommand(command: string[]): Promise<void> {
  const result = await execa(command[0], command.slice(1), {
    stdio: "inherit",
    reject: false,
  });

  if ((result.exitCode ?? 1) !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

function getCacheMounts(homeDir: string): Array<[string, string]> {
  return [
    [path.join(homeDir, ".npm"), "/root/.npm"],
    [path.join(homeDir, ".cache", "pip"), "/root/.cache/pip"],
    [path.join(homeDir, ".cache", "composer"), "/root/.cache/composer"],
    [path.join(homeDir, ".m2"), "/root/.m2"],
    [path.join(homeDir, ".gradle"), "/root/.gradle"],
  ];
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveTargetPath(repoPath: string, config: PreflightConfig): string {
  if (!config.workingDir || config.workingDir === ".") {
    return repoPath;
  }

  const targetPath = path.resolve(repoPath, config.workingDir);
  return fs.existsSync(targetPath) ? targetPath : repoPath;
}

function normalizePackages(packages: string[]): string[] {
  return [...new Set(packages.map((pkg) => pkg.trim()).filter(Boolean))].sort();
}

function isSymfonyProject(repoPath: string): boolean {
  if (fileExists(repoPath, "symfony.lock") || fileExists(repoPath, "bin/console")) {
    return true;
  }

  const composerJson = readJsonFile<{ require?: Record<string, string>; "require-dev"?: Record<string, string> }>(
    path.join(repoPath, "composer.json")
  );
  const packages = {
    ...(composerJson?.require ?? {}),
    ...(composerJson?.["require-dev"] ?? {}),
  };

  return Object.keys(packages).some((name) => name.startsWith("symfony/"));
}

function detectPhpExtensionPackages(repoPath: string): string[] {
  const composerJson = readJsonFile<{ require?: Record<string, string>; "require-dev"?: Record<string, string> }>(
    path.join(repoPath, "composer.json")
  );
  const packages = {
    ...(composerJson?.require ?? {}),
    ...(composerJson?.["require-dev"] ?? {}),
  };

  return Object.keys(packages)
    .filter((name) => name.startsWith("ext-"))
    .map((name) => PHP_EXTENSION_PACKAGE_MAP[name.slice(4)])
    .filter((pkg): pkg is string => Boolean(pkg));
}

function createSandboxFingerprint(
  capabilities: Set<string>,
  aptPackages: string[],
  pipPackages: string[]
): string {
  const dockerfileHash = fs.existsSync(DOCKERFILE_PATH)
    ? createHash("sha256").update(fs.readFileSync(DOCKERFILE_PATH, "utf-8")).digest("hex").slice(0, 12)
    : "missing-dockerfile";
  const payload = JSON.stringify({
    dockerfileHash,
    capabilities: [...capabilities].sort(),
    aptPackages,
    pipPackages,
  });

  return createHash("sha256").update(payload).digest("hex");
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function isAutoBuildCandidate(image: string): boolean {
  return image === DEFAULT_SANDBOX_IMAGE || image.startsWith(`${DEFAULT_SANDBOX_IMAGE}-`);
}

function describeSandboxProfile(profile: SandboxProfile): string {
  const parts = [
    profile.capabilities.length > 0 ? profile.capabilities.join(",") : "default",
    profile.aptPackages.length > 0 ? `apt:${profile.aptPackages.join(",")}` : "",
    profile.pipPackages.length > 0 ? `pip:${profile.pipPackages.join(",")}` : "",
  ].filter(Boolean);

  return parts.join(" | ");
}
