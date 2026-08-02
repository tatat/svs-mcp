/** Note reading, insertion, editing and deletion; track/group creation. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../bridge.js";
import { musicalToBlick, noteValueToBlick, parsePitch } from "../time.js";
import {
  fail,
  fetchTimeSignatures,
  formatNote,
  groupSchema,
  ok,
  trackSchema,
  type NotesResult,
} from "./common.js";

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

const pitchSchema = z
  .union([z.string(), z.number()])
  .describe('Pitch as a note name like "C4"/"F#3"/"Bb4" or a MIDI number (C4=60)');

export function registerNoteTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "add_track",
    {
      description:
        "Add a new track to the current Synthesizer V Studio project and return " +
        "its 1-based track index. New tracks and groups inherit SV's default " +
        "singer; if no singer is configured, the user must pick one in the SV UI.",
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
        "first step before insert_notes when no suitable group exists yet " +
        "(insert_notes also auto-creates a group when the track has none). " +
        "The group inherits SV's default singer.",
      inputSchema: {
        track: trackSchema,
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
        "onset and SHIFT whenever notes are inserted, deleted or moved, so always " +
        "re-read before editing. Positions are formatted as measure.beat (both " +
        "1-based); `phonemes` is only present when a user override is set on the note.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
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
        track: trackSchema,
        group: groupSchema,
        notes: z
          .array(
            z.object({
              lyrics: z.string().describe('Lyric for this note (e.g. "ら", "-", "sing")'),
              pitch: pitchSchema,
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

  server.registerTool(
    "update_notes",
    {
      description:
        "Edit existing notes by their current onset-order index (from get_notes). " +
        "Only the provided fields change. Moving a note in time can re-sort the " +
        "group, so use the returned snapshot (fresh indices) for any follow-up " +
        "edits instead of the old indices. One undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        notes: z
          .array(
            z.object({
              index: z.number().int().min(1).describe("Current note index (see get_notes)"),
              lyrics: z.string().optional().describe("New lyric"),
              pitch: pitchSchema.optional(),
              start: positionSchema.optional().describe("New start position"),
              duration: z
                .union([z.string(), z.number()])
                .optional()
                .describe(noteValueDescription),
            }),
          )
          .min(1)
          .describe("Edits to apply"),
      },
    },
    async ({ track, group, notes }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        const converted = notes.map((edit) => ({
          index: edit.index,
          ...(edit.lyrics !== undefined && { lyrics: edit.lyrics }),
          ...(edit.pitch !== undefined && { pitch: parsePitch(edit.pitch) }),
          ...(edit.start !== undefined && { onset: musicalToBlick(edit.start, signatures) }),
          ...(edit.duration !== undefined && { duration: noteValueToBlick(edit.duration) }),
        }));
        const result = (await bridge.request("update_notes", {
          track,
          ...(group !== undefined && { group }),
          notes: converted,
        })) as NotesResult;
        return ok({
          group: result.group,
          groupName: result.groupName,
          updatedCount: result.updatedCount,
          totalNotes: result.totalNotes,
          notesInAffectedRange: result.notes.map((note) => formatNote(note, signatures)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "delete_notes",
    {
      description:
        "Delete notes by their current onset-order indices (from get_notes). " +
        "Remaining notes are renumbered afterwards, so re-read with get_notes " +
        "before further edits. One undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        indexes: z
          .array(z.number().int().min(1))
          .min(1)
          .describe("Note indices to delete (duplicates rejected)"),
      },
    },
    async ({ track, group, indexes }) => {
      try {
        const result = await bridge.request("delete_notes", {
          track,
          ...(group !== undefined && { group }),
          indexes,
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
