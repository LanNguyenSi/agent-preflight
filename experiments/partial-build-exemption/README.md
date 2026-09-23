# Partial-build exemption measurement

Task ac5b94b3 measured the proposed exemption literally: remove each declared
directory that holds a tracked entry, is not ignored, and has another populated
declared output directory in the same package. Every predicate reads the
original directory readings. The remaining directories retain the ordinary
`entries` or `unreadable` partial-build check. There is no package-wide exemption.

The candidate is rejected. Neither motivating unbuilt case becomes a skip:
its source directory has no other populated output directory to qualify it.
Once built, the tracked source directory qualifies but the ignored, untracked
`dist/` still blocks. The mutual-exemption control does change to a skip:
both committed output directories qualify against each other's original state,
leaving no directory to block a real missing-artifact failure. Shipping source
and tests are unchanged.

## Measured verdicts

Base is `05ffb86ea16fce0444058500ed3c593f95ad4603`. Candidate patch SHA-256:
`c099835b723470f1ab6e39bcfa2b54cab29e930e4ba3cba588d684f5d5827b8f`.
All 15 canonical/base/candidate input hashes matched before either arm ran.
The mutual control is the only verdict change and the only semantic message
change. A skip is unevaluated, not a passing test; here it changes CLI exit 1
and `ready: false` to exit 0 and `ready: true`.

| Row | Base | Candidate |
| --- | --- | --- |
| oclif-bin-dist-unbuilt | fail | fail |
| oclif-bin-dist-built | fail | fail |
| exports-src-dist-unbuilt | fail | fail |
| exports-src-dist-built | fail | fail |
| committed-populated-output | fail | fail |
| committed-dist-symlink-lib | fail | fail |
| committed-placeholder | fail | fail |
| fixture-partial-build-types | fail | fail |
| fixture-partial-build-exports | fail | fail |
| fixture-nested-artifact-dir | fail | fail |
| fixture-second-output-dir | fail | fail |
| fixture-bin-never-emitted | fail | fail |
| fixture-partial-build-uncopied-asset | fail | fail |
| fixture-monorepo-partial-build-uncopied-asset | fail | fail |
| mutual-exemption-control | fail | skip |

The synthetic cases use real Node imports of missing `dist/index.js`; built
variants emit `dist/other.js`. Their recorded build-script/missing-artifact
precondition and output corroboration are both satisfied, isolating the
partial-build decision. Seven fixtures are copied without edits from the
checked revision and built with their own scripts. The first two fixtures
also lack corroboration after their runtime errors, so their unchanged verdicts
alone do not establish discrimination of the partial-build rule.

## Replay

Use a checkout with its npm dependencies installed and `agent-primitives` on
PATH. The driver reads source and fixtures from that checkout's HEAD; it refuses
tracked source/configuration changes. It clones two disposable checkouts, links
the existing dependencies, applies the complete patch with `git apply`, requires
the actual diff to byte-match it, and builds both through `agent-primitives
verify -c build`. It makes no network requests or installs.

```sh
case_parent=$(mktemp -d)
node experiments/partial-build-exemption/driver.mjs \
  --repository="$PWD" --output="$case_parent/measurement"
```

Both flags are required. Output must not exist, and its parent must exist.
Existing files, directories, and symlinks are refused. The driver never deletes
caller paths or rewrites this directory's reviewed `results.json`. Setup,
application, snapshot, JSON, and baseline-sanity failures exit nonzero and leave
`failure.json`; a successfully measured rejection exits zero. An accepted
candidate reports `request-approval` and requires a separate implementation
decision. This script never installs the candidate in the source checkout.

Each case writes its ignore rules before the initial commit. Generated `dist/`
and `lib/` files stay ignored/untracked; committed controls explicitly unignore
them and use ordinary `git add`, never force-add. The symlink control declares
only `dist/`, with a tracked `dist -> lib` link; the mutual control declares both
`dist/` and `lib/`. Global and system Git configuration are disabled for the
experiment. A canonical case is copied, preserving symlink targets, into both
arms. Recursive hashes include paths, entry types, modes, empty directories,
file contents and link targets, including ignored outputs; only `.git` is
excluded. Both hashes are collected before either test runs.

Each arm runs the CLI with the same `TEST_ONLY_CHECKS` configuration as
`tests/build-required.test.ts`: only the test check is enabled. This isolation
is for the experiment, not the repository's full verification set. Raw command
records retain executable/arguments/cwd, actual exits, signals, stdout and
stderr. Full npm-test logs, git tracked/ignored classifications, original
directory readings, exempt/remaining directories, and direct classifier
readings remain under the output directory. `results.json` references those
files; the output tree is the unabridged local evidence.

## Published normalization

The tracked `results.json` retains every field from the measured result. Only
two literal absolute-prefix substitutions are made: the measurement output
directory becomes `$CASE_ROOT`, and its source checkout becomes
`$CASE_ROOT/source-repository`. No timestamps, durations, statuses, diagnostics,
or other values are stripped. Referenced raw files live in a replay output,
not in this tracked directory. Review the raw result before publishing a new
normalized copy. This separate command writes a new file beside the raw result:

```sh
node --input-type=module - "$case_parent/measurement/results.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const input = fs.realpathSync(process.argv[2]);
const raw = fs.readFileSync(input, 'utf8');
const result = JSON.parse(raw);
const normalized = raw
  .replaceAll(path.dirname(input), '$CASE_ROOT')
  .replaceAll(result.repository, '$CASE_ROOT/source-repository');
fs.writeFileSync(path.join(path.dirname(input), 'results.normalized.json'), normalized, { flag: 'wx' });
NODE
```

For semantic message comparison only, the driver replaces each arm's full
case-directory prefix with `$CASE_ROOT` before comparing `message`. Raw messages
are preserved; differences eliminated by this substitution are listed in
`path_only_message_changes`. Replay comparisons should check row snapshots,
verdicts and normalized messages, not byte-equality of timings or log filenames.

An earlier attempt incorrectly exempted a whole package, built the unbuilt rows,
force-added ignored controls and compared Git status instead of input contents.
It is invalid evidence and is not the basis of these results. The run record
retains it separately, along with two aborted setup attempts and a superseded
repair measurement. This measurement does not claim that every possible
repository stays blocked; the mutual control demonstrates the opposite.
