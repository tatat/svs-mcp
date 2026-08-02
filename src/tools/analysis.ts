/** Melody analysis tools that support the lyric flow-in workflow. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../bridge.js";
import { detectPhrases, labelPhraseShapes } from "../phrases.js";
import { blickToMusical, blickToNoteValue, formatPitch, noteValueToBlick } from "../time.js";
import {
  fail,
  fetchTimeSignatures,
  groupSchema,
  ok,
  trackSchema,
  type NotesResult,
} from "./common.js";

const signatureMarkSchema = z.object({
  measure: z.number().int().min(1).describe("Measure where the signature takes effect, 1-based"),
  numerator: z.number().int().min(1).max(32).describe("Beats per measure (e.g. 3 for 3/4)"),
  denominator: z
    .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)])
    .describe("Beat unit (e.g. 4 for 3/4)"),
});

export function registerAnalysisTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "set_time_signature",
    {
      description:
        "Add, update or remove time signature marks so SV's grid matches the " +
        "music (useful after importing MIDI without meter information; see " +
        "get_phrases for inferring the real meter from the notes). Removals are " +
        "applied before additions. NOTE: this changes how measure/beat " +
        "positions map to time for every other tool, so set signatures before " +
        "doing position-based work. One undo step. Returns the resulting " +
        "signature list.",
      inputSchema: {
        marks: z
          .array(signatureMarkSchema)
          .optional()
          .describe("Signature marks to add or update"),
        remove: z
          .array(z.number().int().min(1))
          .optional()
          .describe("1-based measure numbers whose marks should be removed"),
      },
    },
    async ({ marks, remove }) => {
      try {
        if ((marks?.length ?? 0) === 0 && (remove?.length ?? 0) === 0) {
          throw new Error("Provide marks and/or remove.");
        }
        const result = (await bridge.request("set_time_signature", {
          ...(marks && {
            marks: marks.map((m) => ({ ...m, measure: m.measure - 1 })),
          }),
          ...(remove && { remove: remove.map((m) => m - 1) }),
        })) as { timeSignatures: Array<{ measure: number }> };
        return ok({
          timeSignatures: result.timeSignatures.map((s) => ({ ...s, measure: s.measure + 1 })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_phrases",
    {
      description:
        "Analyze a track's melody into phrases by finding rests between notes — " +
        "the recommended first step when flowing lyrics onto an imported melody. " +
        "Each phrase reports its note index range, note count (= syllables " +
        "needed), position, pitch range, current lyrics, and a `shape` label — " +
        "phrases sharing a letter have an identical melody, which usually means " +
        "they carry the same (or parallel) lyric line. Long rests are flagged " +
        "as likely section boundaries. Then assign lyrics phrase by phrase " +
        "with set_lyrics using each phrase's firstNote index.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        restThreshold: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            'Minimum rest that separates phrases, as a note value (default "1/8")',
          ),
        sectionThreshold: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            'Minimum rest that suggests a section boundary, as a note value (default "1/1")',
          ),
      },
    },
    async ({ track, group, restThreshold, sectionThreshold }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        const restBlick = noteValueToBlick(restThreshold ?? "1/8");
        const sectionBlick = noteValueToBlick(sectionThreshold ?? "1/1");

        const result = (await bridge.request("get_notes", {
          track,
          ...(group !== undefined && { group }),
        })) as NotesResult;

        const detected = detectPhrases(result.notes, restBlick, sectionBlick);
        const shapes = labelPhraseShapes(detected, result.notes);
        const phrases = detected.map((phrase) => {
          const notes = result.notes.filter(
            (n) => n.index >= phrase.firstNote && n.index <= phrase.lastNote,
          );
          const pitches = notes.map((n) => n.pitch);
          return {
            phrase: phrase.index,
            shape: shapes[phrase.index - 1],
            ...(phrase.sectionBreakBefore && { sectionBreakBefore: true }),
            gapBefore:
              phrase.gapBeforeBlick === null ? null : blickToNoteValue(phrase.gapBeforeBlick),
            firstNote: phrase.firstNote,
            lastNote: phrase.lastNote,
            noteCount: phrase.noteCount,
            start: blickToMusical(phrase.onsetBlick, signatures).display,
            end: blickToMusical(phrase.endBlick, signatures).display,
            pitchRange: `${formatPitch(Math.min(...pitches))}-${formatPitch(Math.max(...pitches))}`,
            lyrics: notes.map((n) => n.lyrics).join(""),
          };
        });

        return ok({
          group: result.group,
          groupName: result.groupName,
          totalNotes: result.totalNotes,
          phraseCount: phrases.length,
          phrases,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
