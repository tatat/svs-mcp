/** Note reading and insertion tools. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeClient } from "../bridge.js";
import {
  blickToMusical,
  blickToNoteValue,
  formatPitch,
  musicalToBlick,
  noteValueToBlick,
  parsePitch,
  type TimeSignature,
} from "../time.js";

const positionSchema = z
  .object({
    measure: z.number().int().min(1).describe("Measure number, 1-based"),
    beat: z.number().int().min(1).describe("Beat within the measure, 1-based"),
    offset: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Optional note-value offset from the beat, e.g. "1/16"'),
  })
  .describe("A musical position (measure and beat are 1-based)");

const noteValueDescription =
  'Note value: a fraction of a whole note like "1/4", "1/8", dotted "1/8.", ' +
  'triplet "1/12", "3/16", or a number meaning that many quarter notes.';

interface BridgeNote {
  index: number;
  lyrics: string;
  phonemes: string;
  pitch: number;
  onset: number;
  duration: number;
}

interface NotesResult {
  totalNotes: number;
  notes: BridgeNote[];
  group?: number;
  groupName?: string;
  createdGroup?: boolean;
  insertedCount?: number;
}

function formatNote(note: BridgeNote, signatures: TimeSignature[]) {
  return {
    index: note.index,
    lyrics: note.lyrics,
    ...(note.phonemes !== "" && { phonemes: note.phonemes }),
    pitch: formatPitch(note.pitch),
    midiPitch: note.pitch,
    position: blickToMusical(note.onset, signatures).display,
    duration: blickToNoteValue(note.duration),
    onsetBlick: note.onset,
    durationBlick: note.duration,
  };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function fetchTimeSignatures(bridge: BridgeClient): Promise<TimeSignature[]> {
  const axis = (await bridge.request("get_time_axis")) as { timeSignatures: TimeSignature[] };
  return axis.timeSignatures;
}

export function registerNoteTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "add_track",
    {
      description:
        "Add a new track to the current Synthesizer V Studio project and return " +
        "its 1-based track index. Note: a fresh track starts without a singer; " +
        "create a group (create_group) and have the user assign a singer to it " +
        "in the SV UI before the notes will be audible.",
      inputSchema: {
        name: z.string().optional().describe("Optional name for the new track"),
      },
    },
    async ({ name }) => {
      try {
        const result = await bridge.request("add_track", {
          ...(name !== undefined && { name }),
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "create_group",
    {
      description:
        "Create a new empty note group on a track and return its group index. " +
        "In SV Studio 2 the singer is assigned per group, so this is the usual " +
        "first step before insert_notes when no suitable group exists yet. " +
        "The user may still need to pick a singer for the new group in the SV UI.",
      inputSchema: {
        track: z.number().int().min(1).describe("Track index, 1-based"),
        name: z.string().optional().describe("Optional name for the new group"),
      },
    },
    async ({ track, name }) => {
      try {
        const result = await bridge.request("create_group", {
          track,
          ...(name !== undefined && { name }),
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_notes",
    {
      description:
        "List the notes of a track in the current Synthesizer V Studio project. " +
        "Track indices are 1-based (see get_project_info). Note indices are ordered by " +
        "onset and SHIFT whenever notes are inserted or deleted, so always re-read " +
        "before editing. Positions are formatted as measure.beat (both 1-based); " +
        "`phonemes` is only present when a user override is set on the note.",
      inputSchema: {
        track: z.number().int().min(1).describe("Track index, 1-based"),
        group: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Group index within the track (see get_project_info `groups`). " +
              "Defaults to the first non-main group (the singing one); falls " +
              "back to the main group only when no other group exists.",
          ),
        fromMeasure: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First measure to include (1-based, inclusive)"),
        toMeasure: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Last measure to include (1-based, inclusive)"),
      },
    },
    async ({ track, group, fromMeasure, toMeasure }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        const params: Record<string, unknown> = { track };
        if (group !== undefined) params.group = group;
        if (fromMeasure !== undefined) {
          params.startBlick = musicalToBlick({ measure: fromMeasure, beat: 1 }, signatures);
        }
        if (toMeasure !== undefined) {
          params.endBlick = musicalToBlick({ measure: toMeasure + 1, beat: 1 }, signatures);
        }
        const result = (await bridge.request("get_notes", params)) as NotesResult;
        return ok({
          group: result.group,
          groupName: result.groupName,
          totalNotes: result.totalNotes,
          notes: result.notes.map((note) => formatNote(note, signatures)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "insert_notes",
    {
      description:
        "Insert notes into a track (1-based index) of the current Synthesizer V Studio " +
        "project. Each note needs lyrics, pitch, duration, and a start position; when " +
        "`start` is omitted the note begins right after the previous note in this call " +
        "(the first note must have an explicit start). The insertion is one undo step. " +
        "Lyric conventions: Japanese lyrics use ONE kana (or small-kana cluster like " +
        "きゃ) per note; use \"-\" as the lyric to extend the previous vowel across a " +
        "note; use \"+\" to continue a multi-syllable English word. Returns a snapshot " +
        "of all notes overlapping the inserted range, with fresh indices.",
      inputSchema: {
        track: z.number().int().min(1).describe("Track index, 1-based"),
        group: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Group index within the track (see get_project_info `groups`). " +
              "Defaults to the first non-main group; when the track has none, " +
              "a new group is created automatically. AVOID group 1 (main): in " +
              "SV Studio 2 the singer is assigned per group and main-group " +
              "notes are not synthesized.",
          ),
        notes: z
          .array(
            z.object({
              lyrics: z.string().describe('Lyric for this note (e.g. "ら", "-", "sing")'),
              pitch: z
                .union([z.string(), z.number()])
                .describe('Pitch as a note name like "C4"/"F#3"/"Bb4" or a MIDI number (C4=60)'),
              start: positionSchema.optional().describe(
                "Start position. Omit to place right after the previous note in this call.",
              ),
              duration: z.union([z.string(), z.number()]).describe(noteValueDescription),
            }),
          )
          .min(1)
          .describe("Notes to insert, in temporal order"),
      },
    },
    async ({ track, group, notes }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        let cursor: number | null = null;
        const converted = notes.map((note, i) => {
          let onset: number;
          if (note.start !== undefined) {
            onset = musicalToBlick(note.start, signatures);
          } else if (cursor !== null) {
            onset = cursor;
          } else {
            throw new Error(`Note ${i + 1} has no start position (the first note needs one).`);
          }
          const duration = noteValueToBlick(note.duration);
          cursor = onset + duration;
          return { lyrics: note.lyrics, pitch: parsePitch(note.pitch), onset, duration };
        });

        const result = (await bridge.request("insert_notes", {
          track,
          ...(group !== undefined && { group }),
          notes: converted,
        })) as NotesResult;
        return ok({
          group: result.group,
          groupName: result.groupName,
          ...(result.createdGroup && { createdGroup: true }),
          insertedCount: result.insertedCount,
          totalNotes: result.totalNotes,
          notesInAffectedRange: result.notes.map((note) => formatNote(note, signatures)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
