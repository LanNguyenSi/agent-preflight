/**
 * Screening of repo-supplied `actFlags` before they reach `act`.
 *
 * Two flag shapes turn the leading `--dryrun` into step execution:
 *  - a platform mapping whose value is `-self-hosted` (any label), which makes
 *    act run the `run:` steps on the host, and
 *  - a dry-run override (`--dryrun=false` and every other spelling act's flag
 *    parser reads as false), which makes act create job containers and run the
 *    steps in them.
 * The scanner is deliberately conservative: it inspects every token on its own,
 * including a token that act would consume as the value of a preceding flag, so
 * an ambiguous spelling is refused rather than guessed at.
 *
 * The flag grammar mirrors act's pflag parser (act 0.2.89): `--name=value`,
 * `-X value`, `-Xvalue`, `-X=value`, and clusters of short flags such as
 * `-bn=false`. Boolean values follow strconv.ParseBool.
 */

/** Short flags of `act` that take a value (a, C, e, j, P, s, W); the rest are booleans. */
const SHORT_VALUE_FLAGS = new Set(["a", "C", "e", "j", "P", "s", "W"]);
const SHORT_BOOL_FLAGS = new Set(["b", "g", "h", "l", "n", "p", "q", "r", "v", "w"]);

/** The spellings strconv.ParseBool reads as true; anything else sent to --dryrun is refused. */
const BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

const SELF_HOSTED_SUFFIX = "-self-hosted";

/**
 * act compares the platform value with `-self-hosted` through Go's
 * strings.EqualFold, which folds some non-ASCII characters onto ASCII letters
 * (U+017F LATIN SMALL LETTER LONG S matches `s`), so an ASCII-only suffix
 * compare is not enough. One conservative rule covers both: a value that ends
 * in `-self-hosted` when compared as ASCII ignoring case, or any value that
 * contains a non-ASCII character (Docker image references are ASCII-only), is
 * refused.
 */
function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

function platformValueProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (hasNonAscii(value)) return NON_ASCII_REASON;
  if (value.toLowerCase().endsWith(SELF_HOSTED_SUFFIX)) return SELF_HOSTED_REASON;
  return undefined;
}

function isDryrunOverride(value: string): boolean {
  return !BOOL_TRUE.has(value);
}

function shown(text: string): string {
  const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return JSON.stringify(clipped);
}

const SELF_HOSTED_REASON =
  "a self-hosted platform mapping (a value ending in -self-hosted) makes act run workflow steps on this host";
const NON_ASCII_REASON =
  "a platform mapping value with a non-ASCII character is refused: act compares the value with -self-hosted using Unicode case folding (U+017F matches s), and Docker image references are ASCII-only";
const DRYRUN_REASON = "a --dryrun override makes act create job containers and run workflow steps";

/**
 * Returns the refusal message for the first unsafe entry in `actFlags`, or
 * undefined when none of the entries is a self-hosted mapping or a dry-run
 * override.
 */
export function findUnsafeActFlag(actFlags: readonly string[]): string | undefined {
  for (let i = 0; i < actFlags.length; i++) {
    const token = actFlags[i];
    const next = actFlags[i + 1];

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq < 0 ? body : body.slice(0, eq);
      const inline = eq < 0 ? undefined : body.slice(eq + 1);
      if (name === "dryrun" && inline !== undefined && isDryrunOverride(inline)) {
        return refusal(token, DRYRUN_REASON);
      }
      if (name === "platform") {
        const value = inline ?? next;
        const problem = platformValueProblem(value);
        if (problem !== undefined) {
          return refusal(inline === undefined ? `${token} ${next}` : token, problem);
        }
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      for (let j = 1; j < token.length; j++) {
        const flag = token[j];
        const rest = token.slice(j + 1);
        if (SHORT_BOOL_FLAGS.has(flag)) {
          if (rest.startsWith("=")) {
            if (flag === "n" && isDryrunOverride(rest.slice(1))) return refusal(token, DRYRUN_REASON);
            break;
          }
          continue;
        }
        if (SHORT_VALUE_FLAGS.has(flag)) {
          if (flag === "P") {
            const value = rest.startsWith("=") ? rest.slice(1) : rest.length > 0 ? rest : next;
            const problem = platformValueProblem(value);
            if (problem !== undefined) {
              return refusal(rest.length > 0 ? token : `${token} ${next}`, problem);
            }
          }
          break;
        }
        break;
      }
    }
  }
  return undefined;
}

function refusal(entry: string, reason: string): string {
  return (
    `CI simulation refused: actFlags entry ${shown(entry)} is not allowed because ${reason}. ` +
    "Remove it from actFlags in the config; container platform mappings stay allowed."
  );
}
