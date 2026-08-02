/** Pronunciation control: phoneme inspection/overrides and language. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../bridge.js";
import { fail, groupSchema, ok, trackSchema } from "./common.js";

export function registerPhonemeTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "get_phonemes",
    {
      description:
        "Get the phonemes actually used for synthesis for every note in a group " +
        "(SV's text-to-phoneme output), alongside any user overrides. Useful to " +
        "check pronunciation before or after edits. If `complete` is false the " +
        "converter was still running — retry after a moment.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
      },
    },
    async ({ track, group }) => {
      try {
        const result = await bridge.request("get_phonemes", {
          track,
          ...(group !== undefined && { group }),
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "set_phonemes",
    {
      description:
        "Override the phonemes of specific notes (by onset-order index from " +
        "get_notes). Phonemes are space-separated, e.g. Japanese \"k a\", " +
        "English \"hh ah l ow\" (romaji-style for Japanese, ARPABET-style for " +
        "English). Pass an empty string to remove the override and return to " +
        "the automatic pronunciation. One undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        notes: z
          .array(
            z.object({
              index: z.number().int().min(1).describe("Note index (see get_notes)"),
              phonemes: z
                .string()
                .describe('Space-separated phonemes, e.g. "k a"; "" resets to automatic'),
            }),
          )
          .min(1)
          .describe("Phoneme overrides to apply"),
      },
    },
    async ({ track, group, notes }) => {
      try {
        const result = await bridge.request("set_phonemes", {
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

  server.registerTool(
    "set_language",
    {
      description:
        "Set a per-note language override for mixed-language songs (e.g. an " +
        "English word inside Japanese lyrics). Applies to the given note " +
        "indices. Pass an empty string to reset notes to the group/track " +
        "default language.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        indexes: z
          .array(z.number().int().min(1))
          .min(1)
          .describe("Note indices to change (see get_notes)"),
        language: z
          .enum(["japanese", "english", "mandarin", "cantonese", ""])
          .describe('Language override; "" resets to the default'),
      },
    },
    async ({ track, group, indexes, language }) => {
      try {
        const result = await bridge.request("set_language", {
          track,
          ...(group !== undefined && { group }),
          indexes,
          language,
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
