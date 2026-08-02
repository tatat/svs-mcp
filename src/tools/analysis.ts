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

export function registerAnalysisTools(server: McpServer, bridge: BridgeClient): void {
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
