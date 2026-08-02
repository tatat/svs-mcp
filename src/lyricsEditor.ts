/**
 * Local HTTP editor for confirming lyric syllable boundaries before applying.
 *
 * The AI proposes syllables per phrase; the user adjusts boundaries by editing
 * spaces ("あし た" -> "あ した") in a browser page and submits. The edited
 * plan is then fetched via the companion MCP tool. Binds to 127.0.0.1 only.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface EditorPhrase {
  /** Display label, e.g. "#4 @82.1 (3/4)". */
  label: string;
  /** Number of notes = required syllable count. */
  noteCount: number;
  /** Proposed syllables, one per note. */
  syllables: string[];
}

export interface EditorSubmission {
  submittedAt: string;
  phrases: Array<{ label: string; syllables: string[] }>;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderPage(title: string, phrases: EditorPhrase[]): string {
  const data = JSON.stringify(phrases).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(title)} — svs-mcp lyrics editor</title>
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  p.hint { color: #555; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: .3rem .4rem; vertical-align: middle; }
  td.label { white-space: nowrap; color: #555; font-size: .85rem; }
  td.count { white-space: nowrap; font-variant-numeric: tabular-nums; font-size: .85rem; }
  input.syl { width: 100%; font-size: 1.05rem; padding: .35rem .5rem; box-sizing: border-box;
              border: 1px solid #ccc; border-radius: 6px; }
  tr.ng input.syl { border-color: #d33; background: #fff5f5; }
  .ok { color: #2a7; } .ng { color: #d33; font-weight: bold; }
  button { font-size: 1rem; padding: .5rem 1.4rem; margin-top: 1rem; border-radius: 8px;
           border: 1px solid #888; background: #f5f5f5; cursor: pointer; }
  #status { margin-left: 1rem; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="hint">スペースで言葉の切れ目を調整してください (例: 「あし た」→「あ した」)。
右の数字は 現在の音節数 / 必要ノート数 です。</p>
<table id="rows"></table>
<button id="submit">この内容で確定</button><span id="status"></span>
<script>
const phrases = ${data};
const rows = document.getElementById("rows");
const tokenize = (s) => s.split(/\\s+/u).filter((t) => t.length > 0);
phrases.forEach((p, i) => {
  const tr = document.createElement("tr");
  tr.innerHTML = '<td class="label"></td><td><input class="syl"></td><td class="count"></td>';
  tr.querySelector(".label").textContent = p.label;
  const input = tr.querySelector("input");
  input.value = p.syllables.join(" ");
  const count = tr.querySelector(".count");
  const update = () => {
    const n = tokenize(input.value).length;
    count.textContent = n + " / " + p.noteCount;
    const ok = n === p.noteCount;
    count.className = "count " + (ok ? "ok" : "ng");
    tr.className = ok ? "" : "ng";
  };
  input.addEventListener("input", update);
  update();
  rows.appendChild(tr);
});
document.getElementById("submit").addEventListener("click", async () => {
  const result = phrases.map((p, i) => ({
    label: p.label,
    syllables: tokenize(rows.querySelectorAll("input")[i].value),
  }));
  const res = await fetch("/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrases: result }),
  });
  document.getElementById("status").textContent =
    res.ok ? "送信しました。チャットに戻って続けてください。" : "送信に失敗しました";
});
</script>
</body>
</html>`;
}

export class LyricsEditor {
  private server: http.Server | null = null;
  private page = "";
  private submission: EditorSubmission | null = null;

  /** Publish a new plan (clears any previous submission) and return the URL. */
  async open(title: string, phrases: EditorPhrase[]): Promise<string> {
    this.page = renderPage(title, phrases);
    this.submission = null;

    if (this.server === null) {
      this.server = http.createServer((req, res) => this.handle(req, res));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", resolve);
      });
      this.server.unref();
    }
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/`;
  }

  /** The user's submitted edit, or null if not submitted yet. */
  result(): EditorSubmission | null {
    return this.submission;
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(this.page);
      return;
    }
    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { phrases: EditorSubmission["phrases"] };
          this.submission = {
            submittedAt: new Date().toISOString(),
            phrases: parsed.phrases,
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }
}
