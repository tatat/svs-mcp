/**
 * End-to-end test: BridgeClient (TypeScript) talking to the real Lua bridge
 * (sv-scripts/SVSMCPBridge.lua) running under test/sv-stub.lua.
 *
 * Skipped when no `lua` interpreter is on PATH.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge.js";

const hasLua = spawnSync("lua", ["-v"]).status === 0;

describe.skipIf(!hasLua)("Lua bridge (via SV stub)", () => {
  let dir: string;
  let luaProcess: ChildProcess;
  let client: BridgeClient;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "svs-mcp-lua-"));
    luaProcess = spawn("lua", ["test/sv-stub.lua"], {
      env: { ...process.env, SVS_MCP_BRIDGE_DIR: dir },
      stdio: "inherit",
    });
    client = new BridgeClient({ dir, timeoutMs: 5_000, pollMs: 20 });
    // The bridge deletes leftover request/response files on startup; wait for
    // its readiness marker so our first request does not race that cleanup.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await fs.access(path.join(dir, "bridge.json"));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error("Lua bridge did not become ready");
  });

  afterEach(async () => {
    luaProcess.kill();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("answers ping with host info", async () => {
    const result = (await client.request("ping")) as Record<string, unknown>;
    expect(result.hostName).toBe("Synthesizer V Studio Pro (stub)");
    expect(result.hostVersion).toBe("2.1.2");
    expect(result.bridgeVersion).toBe(1);
  });

  it("returns project info", async () => {
    const result = (await client.request("get_project_info")) as {
      fileName: string;
      tempo: Array<{ bpm: number }>;
      timeSignatures: Array<{ numerator: number; denominator: number }>;
      tracks: Array<{ index: number; name: string; noteCount: number }>;
    };
    expect(result.fileName).toBe("/tmp/stub-project.svp");
    expect(result.tempo).toEqual([{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]);
    expect(result.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      index: 1,
      name: "Stub Track",
      noteCount: 3,
      muted: false,
      groups: [{ index: 1, isMain: true, noteCount: 3 }],
    });
  });

  it("lists notes with range filtering", async () => {
    const QUARTER = 705_600_000;
    const all = (await client.request("get_notes", { track: 1 })) as {
      totalNotes: number;
      notes: Array<{ index: number; lyrics: string; pitch: number; onset: number }>;
    };
    expect(all.totalNotes).toBe(3);
    expect(all.notes.map((n) => n.pitch)).toEqual([60, 62, 64]);
    expect(all.notes.map((n) => n.index)).toEqual([1, 2, 3]);

    const filtered = (await client.request("get_notes", {
      track: 1,
      startBlick: QUARTER,
      endBlick: 2 * QUARTER,
    })) as { totalNotes: number; notes: Array<{ pitch: number }> };
    expect(filtered.totalNotes).toBe(3);
    expect(filtered.notes.map((n) => n.pitch)).toEqual([62]);
  });

  it("auto-creates a singing group when inserting without a group", async () => {
    const QUARTER = 705_600_000;
    const result = (await client.request("insert_notes", {
      track: 1,
      notes: [
        { lyrics: "た", pitch: 65, onset: 3 * QUARTER, duration: QUARTER },
        { lyrics: "-", pitch: 67, onset: 4 * QUARTER, duration: QUARTER / 2 },
      ],
    })) as {
      group: number;
      createdGroup: boolean;
      insertedCount: number;
      totalNotes: number;
      notes: Array<{ index: number; lyrics: string; onset: number }>;
    };
    // The stub track only had the (silent) main group, so a new one is made.
    expect(result.createdGroup).toBe(true);
    expect(result.group).toBe(2);
    expect(result.insertedCount).toBe(2);
    expect(result.totalNotes).toBe(2);
    expect(result.notes.map((n) => n.lyrics)).toEqual(["た", "-"]);
    expect(result.notes.map((n) => n.index)).toEqual([1, 2]);

    // Default reads now target the non-main group; main is untouched.
    const defaultRead = (await client.request("get_notes", { track: 1 })) as {
      group: number;
      notes: Array<{ lyrics: string }>;
    };
    expect(defaultRead.group).toBe(2);
    expect(defaultRead.notes.map((n) => n.lyrics)).toEqual(["た", "-"]);

    const main = (await client.request("get_notes", { track: 1, group: 1 })) as {
      notes: Array<{ lyrics: string }>;
    };
    expect(main.notes.map((n) => n.lyrics)).toEqual(["ら", "ら", "ら"]);
  });

  it("adds a track with its own main group", async () => {
    const created = (await client.request("add_track", { name: "Chorus" })) as {
      track: number;
      name: string;
    };
    expect(created).toEqual({ track: 2, name: "Chorus" });

    const notes = (await client.request("get_notes", { track: 2 })) as { totalNotes: number };
    expect(notes.totalNotes).toBe(0);
  });

  it("creates a group and inserts into it", async () => {
    const QUARTER = 705_600_000;
    const created = (await client.request("create_group", {
      track: 1,
      name: "Verse 1",
    })) as { group: number; name: string };
    expect(created.group).toBe(2);
    expect(created.name).toBe("Verse 1");

    const result = (await client.request("insert_notes", {
      track: 1,
      group: created.group,
      notes: [{ lyrics: "ど", pitch: 60, onset: 8 * QUARTER, duration: QUARTER }],
    })) as { totalNotes: number; notes: Array<{ lyrics: string; onset: number }> };
    expect(result.totalNotes).toBe(1);
    expect(result.notes).toEqual([
      expect.objectContaining({ lyrics: "ど", onset: 8 * QUARTER }),
    ]);

    // The main group is untouched.
    const main = (await client.request("get_notes", { track: 1, group: 1 })) as {
      totalNotes: number;
    };
    expect(main.totalNotes).toBe(3);
  });

  it("rejects an invalid track index", async () => {
    await expect(client.request("get_notes", { track: 9 })).rejects.toThrow(
      /Track 9 does not exist/,
    );
  });

  it("reports unknown actions as errors", async () => {
    await expect(client.request("no_such_action")).rejects.toThrow(
      "Unknown action: no_such_action",
    );
  });

  it("shuts down on request and the process exits", async () => {
    const result = (await client.request("shutdown")) as { stopped: boolean };
    expect(result.stopped).toBe(true);
    await new Promise<void>((resolve) => {
      luaProcess.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
    expect(luaProcess.exitCode).toBe(0);
  });
});
