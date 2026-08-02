/** Browser-based confirmation of lyric syllable boundaries. */

import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LyricsEditor } from "../lyricsEditor.js";
import { fail, ok } from "./common.js";

export function registerEditorTools(server: McpServer): void {
  const editor = new LyricsEditor();

  server.registerTool(
    "open_lyrics_editor",
    {
      description:
        "Open a local browser page where the user can review and adjust the " +
        "proposed lyric syllable boundaries BEFORE they are applied (per the " +
        "lyric workflow, readings must be confirmed first). Each phrase is one " +
        "editable line of space-separated syllables (e.g. fixing あし た to " +
        "あ した) with a live count against the phrase's note count. After the " +
        "user says they submitted, call get_lyrics_editor_result and apply the " +
        "edited plan with set_lyrics.",
      inputSchema: {
        title: z.string().optional().describe("Heading shown on the page (e.g. song/section name)"),
        phrases: z
          .array(
            z.object({
              label: z
                .string()
                .describe('Display label for the phrase, e.g. "#4 @82.1" or "サビ 2行目"'),
              noteCount: z.number().int().min(1).describe("Notes in the phrase (= required syllables)"),
              syllables: z.array(z.string()).min(1).describe("Proposed syllables, one per note"),
            }),
          )
          .min(1)
          .describe("The proposed alignment, phrase by phrase"),
      },
    },
    async ({ title, phrases }) => {
      try {
        const url = await editor.open(title ?? "Lyrics preview", phrases);
        // macOS-only project; open the user's default browser.
        try {
          spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
        } catch {
          // Fall through: the URL is still returned for manual opening.
        }
        return ok({
          url,
          note:
            "Editor opened in the browser. Wait for the user to confirm they " +
            "have submitted, then call get_lyrics_editor_result.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_lyrics_editor_result",
    {
      description:
        "Fetch the syllable plan the user submitted from the lyrics editor " +
        "page (see open_lyrics_editor). Returns submitted=false when nothing " +
        "has been submitted yet — ask the user to press the submit button.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = editor.result();
        if (result === null) {
          return ok({ submitted: false });
        }
        return ok({ submitted: true, ...result });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
