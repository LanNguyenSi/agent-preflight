#!/usr/bin/env node
// T-003: retain raw evidence; never change the input checkout or reuse output.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const experiment = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(repository|output)=(.+)$/.exec(arg);
    requireThat(match && !Object.hasOwn(args, match[1]), 'Use exactly --repository=PATH --output=NEW_PATH');
    args[match[1]] = path.resolve(match[2]);
  }
  requireThat(args.repository && args.output, 'Both --repository and --output are required');
  return args;
}
function write(root, relative, content) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: 'wx' });
}
function tree(root) {
  const entries = [];
  function visit(relative) {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      if (name === '.git') continue;
      const child = path.posix.join(relative, name);
      const absolute = path.join(root, child);
      const stat = lstatSync(absolute);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) entries.push({ path: child, kind: 'symlink', mode, target: readlinkSync(absolute) });
      else if (stat.isDirectory()) { entries.push({ path: child, kind: 'directory', mode }); visit(child); }
      else if (stat.isFile()) entries.push({ path: child, kind: 'file', mode, sha256: sha256(readFileSync(absolute)) });
      else throw new Error(`Unsupported snapshot entry: ${child}`);
    }
  }
  visit('');
  return { sha256: sha256(json(entries)), entries };
}

let output;
const commands = [];
function run(executable, argv, cwd, allowed = [0]) {
  const started = new Date().toISOString();
  const child = spawnSync(executable, argv, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  const record = { executable, argv, cwd, started, completed: new Date().toISOString(),
    exitCode: child.status, signal: child.signal, error: child.error?.message ?? null,
    stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
  const reference = `commands/${String(commands.length + 1).padStart(3, '0')}.json`;
  if (output) write(output, reference, json(record));
  commands.push({ reference, ...record });
  requireThat(!record.error && !record.signal && allowed.includes(record.exitCode),
    `Command failed (${record.exitCode}): ${executable} ${argv.join(' ')}; evidence ${reference}`);
  return { ...record, reference };
}
function git(cwd, argv, allowed) { return run('git', argv, cwd, allowed); }
function directoryReading(pkgDir, dir) {
  let state, entries = [], errorCode;
  try { entries = readdirSync(path.resolve(pkgDir, dir)).sort(); state = entries.length ? 'entries' : 'empty'; }
  catch (error) { errorCode = error.code; state = errorCode === 'ENOENT' ? 'absent' : 'unreadable'; }
  const tracked = git(pkgDir, ['ls-files', '-z', '--', dir]);
  const ignored = git(pkgDir, ['check-ignore', '--no-index', '-q', '--', dir], [0, 1]);
  const classification = git(pkgDir, ['check-ignore', '--no-index', '-v', '--', dir], [0, 1]);
  return { dir, state, entries, ...(errorCode ? { errorCode } : {}),
    tracked: tracked.stdout.length > 0, tracked_entries: tracked.stdout.split('\0').filter(Boolean),
    ignored: ignored.exitCode === 0, ignore_classification: classification.stdout,
    commands: [tracked.reference, ignored.reference, classification.reference] };
}
function readingsFor(root, packageDirs) {
  return packageDirs.map(relative => {
    const pkgDir = path.join(root, relative);
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const artifacts = [pkg.main, pkg.module, pkg.types, pkg.typings];
    if (typeof pkg.bin === 'string') artifacts.push(pkg.bin);
    else artifacts.push(...Object.values(pkg.bin ?? {}));
    function collect(value) {
      if (typeof value === 'string') artifacts.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    }
    collect(pkg.exports);
    // This corpus uses explicit file artifacts only, without tsconfig.
    requireThat(!existsSync(path.join(pkgDir, 'tsconfig.json')), 'Unexpected tsconfig in corpus');
    const declared = [...new Set(artifacts.filter(Boolean).map(artifact => {
      requireThat(typeof artifact === 'string' && !artifact.includes('*') && path.extname(artifact),
        'Unexpected artifact shape in corpus');
      return path.dirname(artifact);
    }))];
    requireThat(declared.length && declared.every(dir => dir !== '.' && !dir.startsWith('..') && !path.isAbsolute(dir)),
      'Unexpected output directory in corpus');
    const original = declared.map(dir => directoryReading(pkgDir, dir));
    const exempt = original.filter((reading, index) => reading.tracked && !reading.ignored &&
      original.some((other, otherIndex) => otherIndex !== index && other.state === 'entries'));
    return { package: relative, original, exempt: exempt.map(item => item.dir),
      remaining: original.filter(item => !exempt.includes(item)).map(item => item.dir) };
  });
}

function makeSynthetic(root, row) {
  const manifest = { name: row.name, version: '1.0.0', private: true,
    main: 'dist/index.js', types: 'dist/index.d.ts', scripts: { build: 'node build.js', test: 'node test.js' } };
  let test = "require('./dist/index.js');\n";
  const build = "const fs = require('node:fs');\nfs.mkdirSync('dist', { recursive: true });\n" +
    "fs.writeFileSync('dist/other.js', 'module.exports = {};\\n');\n";
  if (row.shape === 'oclif') {
    manifest.bin = { cli: 'bin/run.js' };
    write(root, 'bin/run.js', "#!/usr/bin/env node\nrequire(require('node:path').join(__dirname, '../dist/index.js'));\n");
    test = "require('./bin/run.js');\n";
  } else if (row.shape === 'exports') {
    manifest.exports = { '.': './src/entry.js' };
    write(root, 'src/entry.js', "module.exports = require(require('node:path').join(__dirname, '../dist/index.js'));\n");
    test = "require('./src/entry.js');\n";
  } else if (row.shape === 'populated') write(root, 'dist/other.js', 'module.exports = {};\n');
  else if (row.shape === 'symlink') {
    write(root, 'lib/other.js', 'module.exports = {};\n');
    symlinkSync('lib', path.join(root, 'dist'));
  } else if (row.shape === 'placeholder') write(root, 'dist/.keep', '');
  else if (row.shape === 'mutual') {
    manifest.exports = { '.': './lib/index.js' };
    write(root, 'dist/other.js', 'module.exports = {};\n');
    write(root, 'lib/other.js', 'module.exports = {};\n');
  } else throw new Error(`Unknown shape: ${row.shape}`);
  write(root, 'package.json', json(manifest));
  write(root, 'build.js', build);
  write(root, 'test.js', test);
}

function main() {
  const args = parseArgs();
  const repository = realpathSync(args.repository);
  const revision = git(repository, ['rev-parse', 'HEAD']).stdout.trim();
  requireThat(git(repository, ['diff', 'HEAD', '--', 'src', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json']).stdout === '',
    'Source, fixtures, and build configuration must match HEAD');
  requireThat(existsSync(path.join(repository, 'node_modules/typescript/bin/tsc')), 'Install repository dependencies before replay');
  // Exclusive mkdir refuses existing directories and symlinks. No deletions.
  mkdirSync(args.output);
  output = realpathSync(args.output);
  // Persist commands executed before the output path could be claimed.
  for (const { reference, ...record } of commands) write(output, reference, json(record));
  const specBytes = readFileSync(path.join(experiment, 'cases.json'));
  const spec = JSON.parse(specBytes);
  requireThat(spec.rows.length === 15 && new Set(spec.rows.map(row => row.name)).size === 15,
    'Corpus requires exactly 15 distinct rows');
  for (const row of spec.rows) {
    requireThat(/^[a-z0-9-]+$/.test(row.name) && typeof row.build === 'boolean', 'Invalid corpus row');
    requireThat(!row.fixture || /^[a-z0-9-]+$/.test(row.fixture), 'Invalid fixture path');
    requireThat(row.packages.every(item => item === '.' || item === 'packages/renderer'), 'Invalid package path');
  }
  const patchBytes = readFileSync(path.join(experiment, 'candidate.patch'));
  write(output, 'candidate.patch', patchBytes);
  const sourceState = { revision, status: git(repository, ['status', '--porcelain=v1', '--untracked-files=all']).stdout,
    diff_sha256: sha256(git(repository, ['diff', 'HEAD']).stdout),
    driver_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), cases_sha256: sha256(specBytes) };
  const repos = {};
  const evaluators = {};
  for (const arm of ['base', 'candidate']) {
    const target = path.join(output, `${arm}-repo`);
    git(repository, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', repository, target]);
    git(target, ['checkout', '--quiet', '--detach', revision]);
    symlinkSync(realpathSync(path.join(repository, 'node_modules')), path.join(target, 'node_modules'));
    if (arm === 'candidate') {
      git(target, ['apply', '--check', path.join(output, 'candidate.patch')]);
      git(target, ['apply', path.join(output, 'candidate.patch')]);
    }
    const appliedDiff = git(target, ['diff', '--no-ext-diff', '--binary', '--', 'src/checks/shared.ts']).stdout;
    write(output, `${arm}-applied.diff`, appliedDiff);
    requireThat(arm === 'base' ? !appliedDiff : appliedDiff === patchBytes.toString(), 'Applied diff must exactly match candidate.patch');
    const build = run('agent-primitives', ['verify', '-c', 'build'], target);
    const verified = JSON.parse(build.stdout);
    requireThat(verified.status === 'pass' && verified.checks?.length === 1 &&
      verified.checks[0].status === 'pass', `Build verification did not pass: ${build.reference}`);
    write(output, `${arm}-build.log`, readFileSync(verified.checks[0].logPath));
    repos[arm] = { path: target, revision, applied_diff_sha256: sha256(appliedDiff),
      source_sha256: sha256(readFileSync(path.join(target, 'src/checks/shared.ts'))),
      built_sha256: sha256(readFileSync(path.join(target, 'dist/checks/shared.js'))), build: build.reference };
    evaluators[arm] = require(path.join(target, 'dist/checks/shared.js'));
  }
  const rows = [];
  for (const row of spec.rows) {
    const canonical = path.join(output, 'cases', 'canonical', row.name);
    mkdirSync(canonical, { recursive: true });
    if (row.fixture) cpSync(path.join(repos.base.path, 'tests/fixtures', row.fixture), canonical,
      { recursive: true, verbatimSymlinks: true });
    else makeSynthetic(canonical, row);
    const ignore = 'node_modules/\ndist/\nlib/\n.preflight-logs/\n' +
      (row.committed ? '!dist\n!dist/\n!dist/**\n!lib/\n!lib/**\n' : '');
    write(canonical, '.gitignore', ignore);
    // Matches TEST_ONLY_CHECKS in tests/build-required.test.ts.
    write(canonical, '.preflight.json', json({ checks: { gitState: false, lint: false, typecheck: false,
      test: true, audit: false, secretDetection: false, commitConvention: false, ciSimulation: false, tdd: false },
    logDir: '.preflight-logs' }));
    git(canonical, ['init', '-q', '--initial-branch=corpus']);
    git(canonical, ['add', '.']);
    git(canonical, ['-c', 'user.email=corpus@example.test', '-c', 'user.name=Corpus', 'commit', '-q', '-m', 'test: prepare corpus']);
    const initial = tree(canonical);
    const build = row.build ? run('npm', ['run', 'build'], canonical).reference : null;
    const snapshot = tree(canonical);
    const tracked = git(canonical, ['ls-files', '--stage']).stdout;
    const trackedPaths = git(canonical, ['ls-files', '-z']).stdout.split('\0').filter(Boolean);
    const classification = git(canonical, ['check-ignore', '--no-index', '-v', '--',
      ...snapshot.entries.map(item => item.path)], [0, 1]);
    const originalReadings = readingsFor(canonical, row.packages);
    if (row.committed) requireThat(originalReadings.every(pkg => pkg.original.every(r => r.tracked && !r.ignored)),
      'Committed controls must be tracked and nonignored');
    else requireThat(!trackedPaths.some(item => /(^|\/)(dist|lib)(\/|$)/.test(item)), 'Generated output was committed');
    if (row.name.endsWith('-unbuilt')) requireThat(!existsSync(path.join(canonical, 'dist')), 'Unbuilt row contains dist');
    const snapshots = { canonical: snapshot.sha256 };
    const casePaths = {};
    // Copy and hash BOTH arms before running either one. Includes ignored files.
    for (const arm of ['base', 'candidate']) {
      casePaths[arm] = path.join(output, 'cases', arm, row.name);
      cpSync(canonical, casePaths[arm], { recursive: true, verbatimSymlinks: true });
      snapshots[arm] = tree(casePaths[arm]).sha256;
    }
    requireThat(Object.values(snapshots).every(value => value === snapshot.sha256), 'Input snapshot mismatch');
    const result = { name: row.name, recipe: row, git_head: git(canonical, ['rev-parse', 'HEAD']).stdout.trim(),
      initial_sha256: initial.sha256, build, snapshots,
      snapshot, tracked, ignore_classification: classification.stdout, original_readings: originalReadings };
    for (const arm of ['base', 'candidate']) {
      const execution = run('node', [path.join(repos[arm].path, 'dist/cli.js'), 'run', casePaths[arm], '--json'],
        casePaths[arm], [0, 1]);
      const parsed = JSON.parse(execution.stdout);
      requireThat(parsed.checks?.length === 1 && parsed.checks[0].kind === 'test', 'Expected isolated test check');
      const test = parsed.checks[0];
      requireThat(['fail', 'skip', 'pass'].includes(test.status) && execution.exitCode === (parsed.ready ? 0 : 1),
        'Inconsistent CLI verdict');
      result[arm] = { exitCode: execution.exitCode, ready: parsed.ready, status: test.status,
        message: test.message, raw: execution.reference, result: parsed };
      const logDir = path.join(casePaths[arm], '.preflight-logs');
      const logs = readdirSync(logDir).filter(name => name.endsWith('.log'));
      requireThat(logs.length === 1, 'Expected one unabridged npm-test log');
      const testOutput = readFileSync(path.join(logDir, logs[0]), 'utf8');
      write(output, `test-output/${arm}/${row.name}.log`, testOutput);
      result[arm].test_output = `test-output/${arm}/${row.name}.log`;
      const api = evaluators[arm];
      result[arm].conditions = row.packages.map(relative => {
        const pkgDir = path.join(casePaths[arm], relative);
        const precondition = api.evaluateBuildPrecondition(pkgDir);
        return { package: relative, precondition, partial: api.evaluatePartialBuild(pkgDir),
          corroboration: api.findMissingArtifactEvidence(testOutput, { repoPath: casePaths[arm], pkgDir,
            missingArtifact: precondition.missingArtifact }) ?? null };
      });
      result[arm].classification = api.evaluateBuildRequiredTestFailure({ repoPath: casePaths[arm], output: testOutput });
      if (!row.fixture) requireThat(result[arm].conditions.every(item => item.precondition.met && item.corroboration),
        'Synthetic row must satisfy the other build-required conditions');
      if (arm === 'base') requireThat(test.status === 'fail' && !parsed.ready, `Base sanity failed: ${row.name}`);
    }
    rows.push(result);
  }
  const verdictChanges = rows.filter(row => row.base.status !== row.candidate.status || row.base.ready !== row.candidate.ready).map(row => row.name);
  const normalize = (message, arm, name) => message?.replaceAll(path.join(output, 'cases', arm, name), '$CASE_ROOT');
  const messageChanges = rows.filter(row => normalize(row.base.message, 'base', row.name) !==
    normalize(row.candidate.message, 'candidate', row.name)).map(row => row.name);
  const pathOnlyMessageChanges = rows.filter(row => row.base.message !== row.candidate.message &&
    !messageChanges.includes(row.name)).map(row => row.name);
  const motivating = rows.filter(row => row.name.endsWith('-unbuilt'));
  const missingMotivatingFlips = motivating.filter(row => row.candidate.status !== 'skip').map(row => row.name);
  const unsafeFlips = rows.filter(row => !row.name.endsWith('-unbuilt') && row.candidate.status !== 'fail').map(row => row.name);
  const decision = missingMotivatingFlips.length || unsafeFlips.length ? 'reject' : 'request-approval';
  const result = { schema: 2, task: 'T-003', acceptance_baseline: { id: 'astra-old-eight', revision: 'r1' },
    criteria: ['T003-AC1', 'T003-AC2', 'T003-AC3'], attempt: path.basename(output),
    repository, source_state: sourceState, command: ['node', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    candidate_patch_sha256: sha256(patchBytes), repos, rows, verdict_changes: verdictChanges,
    message_changes: messageChanges, path_only_message_changes: pathOnlyMessageChanges,
    missing_motivating_flips: missingMotivatingFlips, unsafe_flips: unsafeFlips,
    decision, status: 'complete', exitCode: 0 };
  write(output, 'results.json', json(result));
  write(output, 'commands.json', json(commands.map(item => ({ reference: item.reference, executable: item.executable,
    argv: item.argv, cwd: item.cwd, exitCode: item.exitCode }))));
  console.log(json({ rows: rows.length, verdict_changes: verdictChanges, message_changes: messageChanges,
    missing_motivating_flips: missingMotivatingFlips, unsafe_flips: unsafeFlips, decision }));
}
try { main(); }
catch (error) {
  if (output) write(output, 'failure.json', json({ status: 'failed', exitCode: 1, error: error.stack, commands }));
  console.error(error.stack);
  process.exitCode = 1;
}
