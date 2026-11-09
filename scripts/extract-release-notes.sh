#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: extract-release-notes.sh <version> [changelog] [out]" >&2
}

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Error: a version argument is required (without the leading v)." >&2
  usage
  exit 2
fi

CHANGELOG="${2:-CHANGELOG.md}"
OUTPUT="${3:-release_notes.md}"

if [ ! -f "$CHANGELOG" ]; then
  echo "Error: changelog file not found: $CHANGELOG" >&2
  exit 1
fi

status=0
awk -v prefix="## [${VERSION}" '
  !found && index($0, prefix "]") == 1 { found = 1; next }
  found && index($0, "## [") == 1 { exit }
  found { print }
  END { exit(found ? 0 : 3) }
' "$CHANGELOG" > "$OUTPUT" || status=$?

if [ "$status" -eq 3 ]; then
  rm -f "$OUTPUT"
  echo "Error: no section for version ${VERSION} in ${CHANGELOG}." >&2
  exit 1
fi

if [ "$status" -ne 0 ]; then
  rm -f "$OUTPUT"
  echo "Error: failed to read the changelog or write the output (${CHANGELOG} -> ${OUTPUT})." >&2
  exit 1
fi

if ! grep -q '[^[:space:]]' "$OUTPUT"; then
  rm -f "$OUTPUT"
  echo "Error: section for version ${VERSION} in ${CHANGELOG} is empty." >&2
  exit 1
fi
