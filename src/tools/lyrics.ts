/** Lyric flow-in: assign syllables to consecutive existing notes. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../bridge.js";
import {
  fail,
  fetchTimeSignatures,
  formatNote,
  groupSchema,
  ok,
  trackSchema,
  type NotesResult,
} from "./common.js";

export function registerLyricTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "set_lyrics",
    {
      description:
        "Assign lyrics to consecutive existing notes, starting at a note index " +
        "(from get_notes) — the typical way to put lyrics on an existing melody. " +
        "Each array element goes to one note, in onset order. Japanese: ONE kana " +
        "(or small-kana cluster like きゃ) per note; \"-\" extends the previous " +
        "vowel; \"+\" continues a multi-syllable English word. Fails if the array " +
        "runs past the last note. One undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        startIndex: z
          .number()
          .int()
          .min(1)
          .describe("Index of the first note to receive a lyric (see get_notes)"),
        lyrics: z
          .array(z.string())
          .min(1)
          .describe('Syllables in note order, e.g. ["き", "ら", "き", "ら", "-"]'),
      },
    },
    async ({ track, group, startIndex, lyrics }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        const result = (await bridge.request("set_lyrics", {
          track,
          ...(group !== undefined && { group }),
          startIndex,
          lyrics,
        })) as NotesResult;
        return ok({
          group: result.group,
          groupName: result.groupName,
          updatedCount: result.updatedCount,
          totalNotes: result.totalNotes,
          notes: result.notes.map((note) => formatNote(note, signatures)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
