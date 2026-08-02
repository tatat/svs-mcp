/**
 * Client side of the file bridge to Synthesizer V Studio.
 *
 * SV's scripting API has no network access, so a resident Lua script
 * (sv-scripts/SVSMCPBridge.lua) polls a request file and writes a response
 * file. This module implements the MCP-server side of that protocol:
 *
 *   1. Write `request.json` (via temp file + rename, so the bridge never
 *      sees a partial write).
 *   2. Poll `response.json` until it contains a response whose `id` matches
 *      the request, then delete it and return the result.
 *
 * Responses with a non-matching `id` are stale leftovers from a previous
 * server run and are discarded.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_BRIDGE_DIR = path.join(os.homedir(), ".svs-mcp", "bridge");

const SETUP_HINT =
  "No response from Synthesizer V Studio. Make sure that: " +
  "(1) SV Studio is running, " +
  "(2) SVSMCPBridge.lua is installed in the SV scripts folder, and " +
  "(3) the bridge was started via Scripts > SVS MCP > Start Bridge.";

export interface BridgeClientOptions {
  /** Directory shared with the Lua bridge. Defaults to $SVS_MCP_BRIDGE_DIR or ~/.svs-mcp/bridge. */
  dir?: string;
  /** How long to wait for a response before giving up. */
  timeoutMs?: number;
  /** Interval between response-file polls. */
  pollMs?: number;
}

/** An error reported by the Lua bridge (e.g. bad track index). */
export class BridgeError extends Error {}

/** The bridge did not answer in time (usually: not running). */
export class BridgeTimeoutError extends BridgeError {
  constructor() {
    super(SETUP_HINT);
  }
}

interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BridgeClient {
  private readonly dir: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private seq = 0;
  /** Serializes requests; the protocol allows one in-flight command. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeClientOptions = {}) {
    this.dir = options.dir ?? process.env.SVS_MCP_BRIDGE_DIR ?? DEFAULT_BRIDGE_DIR;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.pollMs = options.pollMs ?? 100;
  }

  get requestPath(): string {
    return path.join(this.dir, "request.json");
  }

  get responsePath(): string {
    return path.join(this.dir, "response.json");
  }

  /** Send a command to the bridge and wait for its result. */
  async request(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const run = this.queue.then(() => this.requestNow(action, params));
    // Keep the chain alive even when a request fails.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async requestNow(action: string, params: Record<string, unknown>): Promise<unknown> {
    await fs.mkdir(this.dir, { recursive: true });

    const id = `${++this.seq}-${randomUUID()}`;
    await fs.rm(this.responsePath, { force: true });

    const tmpPath = path.join(this.dir, `request-${id}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify({ id, action, params }));
    await fs.rename(tmpPath, this.requestPath);

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.tryReadResponse(id);
      if (response) {
        if (!response.ok) {
          throw new BridgeError(response.error ?? "Unknown bridge error");
        }
        return response.result;
      }
      await sleep(this.pollMs);
    }

    // Best effort: withdraw the command so a bridge started later does not
    // execute it unexpectedly.
    await fs.rm(this.requestPath, { force: true });
    throw new BridgeTimeoutError();
  }

  private async tryReadResponse(id: string): Promise<BridgeResponse | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.responsePath, "utf-8");
    } catch {
      return null;
    }

    let parsed: BridgeResponse;
    try {
      parsed = JSON.parse(raw) as BridgeResponse;
    } catch {
      // The bridge writes atomically, so this should not happen; treat it
      // as garbage and drop it.
      await fs.rm(this.responsePath, { force: true });
      return null;
    }

    if (parsed.id !== id) {
      // Stale response from an earlier run.
      await fs.rm(this.responsePath, { force: true });
      return null;
    }

    await fs.rm(this.responsePath, { force: true });
    return parsed;
  }
}
