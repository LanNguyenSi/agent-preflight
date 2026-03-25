#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PREFLIGHT_INSTALL_DIR:-$HOME/.local/share/agent-preflight}"
BIN_DIR="${PREFLIGHT_BIN_DIR:-$HOME/.local/bin}"
TARGET_SCRIPT="$BIN_DIR/preflight"
TARGET_SANDBOX="$BIN_DIR/preflight-sandbox"
SHELL_RC=""
INSTALL_MODE=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: $1 is required but was not found in PATH."
    exit 1
  fi
}

is_source_checkout() {
  [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/src/cli.ts" ]
}

is_release_bundle() {
  [ -f "$SCRIPT_DIR/release-manifest.json" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/dist/cli.js" ] && [ -d "$SCRIPT_DIR/node_modules" ]
}

install_payload() {
  mkdir -p "$INSTALL_DIR" "$BIN_DIR"

  rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/src"
  cp -R "$SCRIPT_DIR/dist" "$INSTALL_DIR/dist"
  cp -R "$SCRIPT_DIR/node_modules" "$INSTALL_DIR/node_modules"
  cp -R "$SCRIPT_DIR/src" "$INSTALL_DIR/src"

  install -m 0644 "$SCRIPT_DIR/package.json" "$INSTALL_DIR/package.json"
  install -m 0644 "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DIR/tsconfig.json"
  install -m 0644 "$SCRIPT_DIR/vitest.config.ts" "$INSTALL_DIR/vitest.config.ts"
  install -m 0644 "$SCRIPT_DIR/Dockerfile" "$INSTALL_DIR/Dockerfile"
  install -m 0644 "$SCRIPT_DIR/README.md" "$INSTALL_DIR/README.md"
  install -m 0755 "$SCRIPT_DIR/agent-preflight-sandbox" "$INSTALL_DIR/agent-preflight-sandbox"

  if [ -f "$SCRIPT_DIR/package-lock.json" ]; then
    install -m 0644 "$SCRIPT_DIR/package-lock.json" "$INSTALL_DIR/package-lock.json"
  fi

  if [ -f "$SCRIPT_DIR/release-manifest.json" ]; then
    install -m 0644 "$SCRIPT_DIR/release-manifest.json" "$INSTALL_DIR/release-manifest.json"
  fi
}

require_command node

if is_release_bundle; then
  INSTALL_MODE="bundle"
elif is_source_checkout; then
  INSTALL_MODE="source"
  require_command npm
  if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    npm --prefix "$SCRIPT_DIR" ci
  fi
  npm --prefix "$SCRIPT_DIR" run build
else
  echo "Error: install.sh must be run from an agent-preflight checkout or release bundle."
  exit 1
fi

install_payload

cat > "$TARGET_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$INSTALL_DIR/dist/cli.js" "\$@"
EOF
chmod 0755 "$TARGET_SCRIPT"

cat > "$TARGET_SANDBOX" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$TARGET_SCRIPT" sandbox "\$@"
EOF
chmod 0755 "$TARGET_SANDBOX"

case "${SHELL:-}" in
  */zsh)
    SHELL_RC="$HOME/.zshrc"
    ;;
  */bash)
    if [ -f "$HOME/.bashrc" ]; then
      SHELL_RC="$HOME/.bashrc"
    else
      SHELL_RC="$HOME/.profile"
    fi
    ;;
  *)
    if [ -f "$HOME/.bashrc" ]; then
      SHELL_RC="$HOME/.bashrc"
    elif [ -f "$HOME/.zshrc" ]; then
      SHELL_RC="$HOME/.zshrc"
    else
      SHELL_RC="$HOME/.profile"
    fi
    ;;
esac

PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""

case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "PATH already contains $BIN_DIR"
    ;;
  *)
    touch "$SHELL_RC"
    if grep -Fqx "$PATH_LINE" "$SHELL_RC"; then
      echo "PATH entry is already present in $SHELL_RC"
    else
      printf '\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
      echo "Added PATH entry to $SHELL_RC"
    fi
    echo ""
    echo "Reload your shell:"
    echo "  source $SHELL_RC"
    ;;
esac

echo ""
echo "Installed:"
echo "  $TARGET_SCRIPT"
echo "  $TARGET_SANDBOX"
echo "Mode: $INSTALL_MODE"
echo ""
echo "You can now run:"
echo "  preflight run"
echo "  preflight sandbox"
