#!/usr/bin/env bash
#
# Remove the SVS MCP bridge scripts installed by scripts/install.sh, and the
# runtime bridge directory (~/.svs-mcp).
#
# Override the SV scripts folder with $SV_SCRIPTS_DIR if needed.

set -euo pipefail

SV_SCRIPTS_DIR="${SV_SCRIPTS_DIR:-$HOME/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts}"
TARGET_DIR="$SV_SCRIPTS_DIR/svs-mcp"

if [[ -d "$TARGET_DIR" ]]; then
  rm -f "$TARGET_DIR/SVSMCPBridge.lua" "$TARGET_DIR/SVSMCPBridgeStop.lua"
  rmdir "$TARGET_DIR" 2>/dev/null || true
  echo "Removed bridge scripts from: $TARGET_DIR"
else
  echo "Nothing to remove at: $TARGET_DIR"
fi

# Only remove the runtime directory when it is the default one; a custom
# $SVS_MCP_BRIDGE_DIR could point anywhere, so leave that to the user.
if [[ -n "${SVS_MCP_BRIDGE_DIR:-}" ]]; then
  echo "Note: SVS_MCP_BRIDGE_DIR is set ($SVS_MCP_BRIDGE_DIR); remove it yourself if no longer needed."
elif [[ -d "$HOME/.svs-mcp" ]]; then
  rm -rf "$HOME/.svs-mcp"
  echo "Removed bridge runtime directory: $HOME/.svs-mcp"
fi

echo "Done. If SV Studio is running, the Scripts menu updates after Rescan or restart."
