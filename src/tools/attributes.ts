/**
 * Per-note voice attributes (SV's Note#getAttributes / #setAttributes):
 * per-phoneme timing/strength, vibrato modulation, expression pad, etc.
 * Mainly used to copy a hand-tuned note onto the other occurrences of the
 * same phrase.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../bridge.js";
import { fail, groupSchema, ok, trackSchema } from "./common.js";

const NAN_NOTE =
  'Values that are "not set, use the default" are NaN inside SV and appear ' +
  'as the string "NaN"; pass "NaN" to reset a value to the default.';

export function registerAttributeTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "get_note_attributes",
    {
      description:
        "Read the voice attributes of specific notes (by onset-order index from " +
        "get_notes), as returned by SV's Note#getAttributes. Includes " +
        "`phonemes`: one entry per phoneme of the note, in order, with " +
        "`leftOffset` (timing shift), `position`, `activity` and `strength` " +
        "(phoneme pronunciation strength); SV 2 only reports the values the user " +
        "actually changed (an untouched note has `phonemes: []`). Also " +
        "note-level values such as `dF0VbrMod`, `expValueX`/`expValueY`, " +
        "`muted`, `evenSyllableDuration`. " +
        NAN_NOTE,
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        indexes: z
          .array(z.number().int().min(1))
          .min(1)
          .describe("Note indices to read (see get_notes)"),
      },
    },
    async ({ track, group, indexes }) => {
      try {
        const result = await bridge.request("get_note_attributes", {
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

  server.registerTool(
    "set_note_attributes",
    {
      description:
        "Set voice attributes of specific notes (SV's Note#setAttributes). The " +
        "attributes object is partial: only the given properties change. To " +
        "copy a hand-tuned note to other occurrences of the same phrase, read " +
        "it with get_note_attributes and pass its `attributes` here for each " +
        "target note. The `phonemes` array is matched to the note's phonemes " +
        "by position, so copy only between notes with the same pronunciation. " +
        NAN_NOTE +
        " One undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        notes: z
          .array(
            z.object({
              index: z.number().int().min(1).describe("Note index (see get_notes)"),
              attributes: z
                .record(z.string(), z.unknown())
                .describe("Attributes to set, same shape as get_note_attributes"),
            }),
          )
          .min(1)
          .describe("Attribute edits to apply"),
      },
    },
    async ({ track, group, notes }) => {
      try {
        const result = await bridge.request("set_note_attributes", {
          track,
          ...(group !== undefined && { group }),
          notes,
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
