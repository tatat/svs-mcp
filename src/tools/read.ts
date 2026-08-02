/** Read-only tools: bridge liveness and project inspection. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeClient, BridgeError } from "../bridge.js";

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function registerReadTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "ping",
    {
      description:
        "Check that the bridge script inside Synthesizer V Studio is running. " +
        "Returns host information (SV edition, version, OS) on success. " +
        "Call this first if other tools time out.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await bridge.request("ping"));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_project_info",
    {
      description:
        "Get an overview of the project currently open in Synthesizer V Studio: " +
        "file name, tempo marks, time signatures, and the track list with note counts. " +
        "Track indices returned here are used by all other tools.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await bridge.request("get_project_info"));
      } catch (error) {
        return fail(error);
      }
    },
  );
}

export { BridgeError };
