#!/usr/bin/env bash
#
# Install the SVS MCP bridge scripts into Synthesizer V Studio 2.
#
# Copies sv-scripts/*.lua into a "svs-mcp" subfolder of the SV scripts
# folder so they can be removed cleanly by scripts/uninstall.sh.
#
# Override the target with $SV_SCRIPTS_DIR if your installation is not in
# the default location.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SV_SCRIPTS_DIR="${SV_SCRIPTS_DIR:-$HOME/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts}"
TARGET_DIR="$SV_SCRIPTS_DIR/svs-mcp"

if [[ ! -d "$SV_SCRIPTS_DIR" ]]; then
  echo "error: SV scripts folder not found: $SV_SCRIPTS_DIR" >&2
  echo "Is Synthesizer V Studio 2 installed? Set SV_SCRIPTS_DIR to override." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$REPO_DIR/sv-scripts/SVSMCPBridge.lua" "$TARGET_DIR/"
cp "$REPO_DIR/sv-scripts/SVSMCPBridgeStop.lua" "$TARGET_DIR/"

echo "Installed bridge scripts to: $TARGET_DIR"
echo
echo "Next steps:"
echo "  1. In SV Studio, run Scripts > Rescan (or restart SV Studio)."
echo "  2. Run Scripts > SVS MCP > \"SVS MCP Bridge: Start\"."
echo "  3. Configure your MCP client with: node $REPO_DIR/dist/index.js"
