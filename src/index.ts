#!/usr/bin/env node
/**
 * svs-mcp: MCP server for Synthesizer V Studio.
 *
 * Talks to a resident Lua script inside SV Studio over a file bridge
 * (see src/bridge.ts and sv-scripts/SVSMCPBridge.lua).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge.js";
import { registerLyricTools } from "./tools/lyrics.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerPhonemeTools } from "./tools/phonemes.js";
import { registerReadTools } from "./tools/read.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: "svs-mcp", version: "0.1.0" });
  const bridge = new BridgeClient();

  registerReadTools(server, bridge);
  registerNoteTools(server, bridge);
  registerLyricTools(server, bridge);
  registerPhonemeTools(server, bridge);

  await server.connect(new StdioServerTransport());
  console.error("svs-mcp server running (stdio)");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
