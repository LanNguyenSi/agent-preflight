#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${RELEASE_OUTPUT_DIR:-$REPO_ROOT/out/release}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: $1 is required but was not found in PATH."
    exit 1
  fi
}

checksum_file() {
  local file_path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" > "$file_path.sha256"
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" > "$file_path.sha256"
    return
  fi

  echo "Error: sha256sum or shasum is required to generate checksums."
  exit 1
}

require_command node
require_command npm
require_command tar

if [ ! -f "$REPO_ROOT/package.json" ] || [ ! -f "$REPO_ROOT/src/cli.ts" ]; then
  echo "Error: create-release-bundle.sh must be run from an agent-preflight checkout."
  exit 1
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  npm --prefix "$REPO_ROOT" ci
fi

npm --prefix "$REPO_ROOT" run build

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUNDLE_NAME="agent-preflight-v${VERSION}-bundle"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
BUNDLE_DIR="$TMP_DIR/$BUNDLE_NAME"
ARCHIVE_PATH="$OUTPUT_DIR/$BUNDLE_NAME.tar.gz"

mkdir -p "$BUNDLE_DIR" "$OUTPUT_DIR"

cat > "$BUNDLE_DIR/release-manifest.json" <<EOF
{
  "name": "agent-preflight",
  "version": "$VERSION",
  "gitCommit": "$GIT_COMMIT",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

cp -R "$REPO_ROOT/dist" "$BUNDLE_DIR/dist"
cp -R "$REPO_ROOT/node_modules" "$BUNDLE_DIR/node_modules"
cp -R "$REPO_ROOT/src" "$BUNDLE_DIR/src"
install -m 0755 "$REPO_ROOT/install.sh" "$BUNDLE_DIR/install.sh"
install -m 0755 "$REPO_ROOT/agent-preflight-sandbox" "$BUNDLE_DIR/agent-preflight-sandbox"
install -m 0644 "$REPO_ROOT/package.json" "$BUNDLE_DIR/package.json"
install -m 0644 "$REPO_ROOT/package-lock.json" "$BUNDLE_DIR/package-lock.json"
install -m 0644 "$REPO_ROOT/tsconfig.json" "$BUNDLE_DIR/tsconfig.json"
install -m 0644 "$REPO_ROOT/vitest.config.ts" "$BUNDLE_DIR/vitest.config.ts"
install -m 0644 "$REPO_ROOT/Dockerfile" "$BUNDLE_DIR/Dockerfile"
install -m 0644 "$REPO_ROOT/README.md" "$BUNDLE_DIR/README.md"

rm -f "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256"
tar -C "$TMP_DIR" -czf "$ARCHIVE_PATH" "$BUNDLE_NAME"
checksum_file "$ARCHIVE_PATH"

echo "Created release bundle:"
echo "  $ARCHIVE_PATH"
echo "  $ARCHIVE_PATH.sha256"
