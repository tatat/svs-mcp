/** Protocol tests for BridgeClient against a fake (TypeScript) bridge. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient, BridgeError, BridgeTimeoutError } from "../src/bridge.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "svs-mcp-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface FakeRequest {
  id: string;
  action: string;
  params: Record<string, unknown>;
}

/**
 * Emulates the Lua side: polls request.json, passes it to `handle`, and
 * writes the return value to response.json (atomically). Runs until stopped.
 */
function startFakeBridge(handle: (request: FakeRequest) => Record<string, unknown>) {
  let stopped = false;
  const requestPath = path.join(dir, "request.json");
  const responsePath = path.join(dir, "response.json");

  const tick = async () => {
    while (!stopped) {
      let raw: string | null = null;
      try {
        raw = await fs.readFile(requestPath, "utf-8");
      } catch {
        // no request yet
      }
      if (raw) {
        const request = JSON.parse(raw) as FakeRequest;
        await fs.rm(requestPath, { force: true });
        const response = handle(request);
        const tmp = responsePath + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(response));
        await fs.rename(tmp, responsePath);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const done = tick();
  return {
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}

const client = (timeoutMs = 2_000) => new BridgeClient({ dir, timeoutMs, pollMs: 10 });

describe("BridgeClient", () => {
  it("round-trips a request", async () => {
    const fake = startFakeBridge((request) => ({
      id: request.id,
      ok: true,
      result: { echo: request.action },
    }));
    try {
      const result = await client().request("ping");
      expect(result).toEqual({ echo: "ping" });
    } finally {
      await fake.stop();
    }
  });

  it("discards a stale response and still receives its own", async () => {
    await fs.writeFile(
      path.join(dir, "response.json"),
      JSON.stringify({ id: "old-run", ok: true, result: { stale: true } }),
    );
    const fake = startFakeBridge((request) => ({
      id: request.id,
      ok: true,
      result: { fresh: true },
    }));
    try {
      const result = await client().request("ping");
      expect(result).toEqual({ fresh: true });
    } finally {
      await fake.stop();
    }
  });

  it("surfaces bridge-reported errors as BridgeError", async () => {
    const fake = startFakeBridge((request) => ({
      id: request.id,
      ok: false,
      error: "Track 99 does not exist",
    }));
    try {
      await expect(client().request("get_notes", { track: 99 })).rejects.toThrow(
        "Track 99 does not exist",
      );
      await expect(client().request("get_notes", { track: 99 })).rejects.toBeInstanceOf(
        BridgeError,
      );
    } finally {
      await fake.stop();
    }
  });

  it("times out with setup guidance when no bridge is running", async () => {
    const c = client(200);
    await expect(c.request("ping")).rejects.toBeInstanceOf(BridgeTimeoutError);
    await expect(c.request("ping")).rejects.toThrow(/SVSMCPBridge\.lua/);
    // The command file must be withdrawn so a late-starting bridge does not
    // execute it unexpectedly.
    await expect(fs.access(c.requestPath)).rejects.toThrow();
  });

  it("serializes concurrent requests", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const fake = startFakeBridge((request) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      concurrent--;
      return { id: request.id, ok: true, result: { action: request.action } };
    });
    try {
      const c = client();
      const [a, b] = await Promise.all([c.request("first"), c.request("second")]);
      expect(a).toEqual({ action: "first" });
      expect(b).toEqual({ action: "second" });
      expect(maxConcurrent).toBe(1);
    } finally {
      await fake.stop();
    }
  });
});
