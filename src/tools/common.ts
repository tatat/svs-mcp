/** Helpers shared by tool modules. */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeClient } from "../bridge.js";
import { blickToMusical, blickToNoteValue, formatPitch, type TimeSignature } from "../time.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export const trackSchema = z.number().int().min(1).describe("Track index, 1-based");

export const groupSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "Group index within the track (see get_project_info `groups`). Defaults " +
      "to the first non-main group — in SV Studio 2 the singer is attached " +
      "per group and notes in the main group are not synthesized.",
  );

export interface BridgeNote {
  index: number;
  lyrics: string;
  phonemes: string;
  pitch: number;
  onset: number;
  duration: number;
}

export interface NotesResult {
  totalNotes: number;
  notes: BridgeNote[];
  group?: number;
  groupName?: string;
  createdGroup?: boolean;
  insertedCount?: number;
  updatedCount?: number;
  deletedCount?: number;
}

export function formatNote(note: BridgeNote, signatures: TimeSignature[]) {
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

export async function fetchTimeSignatures(bridge: BridgeClient): Promise<TimeSignature[]> {
  const axis = (await bridge.request("get_time_axis")) as { timeSignatures: TimeSignature[] };
  return axis.timeSignatures;
}
