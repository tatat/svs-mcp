#!/usr/bin/env node
/**
 * Setup verification CLI: checks the file bridge to SV Studio without an MCP
 * client. Exits 0 when the bridge answers, 1 otherwise.
 *
 * Usage: npm run ping
 */

import { BridgeClient } from "./bridge.js";

async function main(): Promise<void> {
  const client = new BridgeClient({ timeoutMs: 5_000 });
  try {
    const result = await client.request("ping");
    console.log("Bridge is running:");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
