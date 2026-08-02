import { afterEach, describe, expect, it } from "vitest";
import { LyricsEditor } from "../src/lyricsEditor.js";

describe("LyricsEditor", () => {
  const editor = new LyricsEditor();

  afterEach(async () => {
    await editor.close();
  });

  it("serves the plan and accepts an edited submission", async () => {
    const url = await editor.open("Test song", [
      { label: "#1 @1.1", noteCount: 3, syllables: ["あし", "た", "!"] },
    ]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(url).then((r) => r.text());
    expect(page).toContain("Test song");
    expect(page).toContain("あし");

    expect(editor.result()).toBeNull();

    const res = await fetch(new URL("/submit", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrases: [{ label: "#1 @1.1", syllables: ["あ", "し", "た"] }],
      }),
    });
    expect(res.ok).toBe(true);

    const result = editor.result();
    expect(result?.phrases).toEqual([{ label: "#1 @1.1", syllables: ["あ", "し", "た"] }]);
    expect(result?.submittedAt).toBeTruthy();
  });

  it("clears the previous submission when a new plan opens", async () => {
    const url = await editor.open("One", [{ label: "a", noteCount: 1, syllables: ["ら"] }]);
    await fetch(new URL("/submit", url), {
      method: "POST",
      body: JSON.stringify({ phrases: [{ label: "a", syllables: ["ら"] }] }),
    });
    expect(editor.result()).not.toBeNull();

    await editor.open("Two", [{ label: "b", noteCount: 1, syllables: ["ど"] }]);
    expect(editor.result()).toBeNull();
  });

  it("escapes HTML in the page", async () => {
    const url = await editor.open("<script>x</script>", [
      { label: "l", noteCount: 1, syllables: ["<b>"] },
    ]);
    const page = await fetch(url).then((r) => r.text());
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>x</script>");
    expect(page).toContain("\\u003cb>");
  });
});
