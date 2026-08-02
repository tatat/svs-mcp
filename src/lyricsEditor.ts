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
  /* Warm pastel palette, light mode only, by user preference. */
  :root {
    --bg: #faf4ec; --card: #fffdf9; --ink: #55463c; --muted: #b3a190;
    --line: #f0e3d3; --accent: #c98545; --accent-soft: #f9e9d2;
    --bad: #c96f74; --bad-soft: #fce8e6;
    --btn-bg: #f6d4a8; --btn-ink: #7c4f1d;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Hiragino Sans", sans-serif;
    background: var(--bg); color: var(--ink);
    margin: 0; padding: 2.5rem 1.25rem 6.5rem;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: .01em; margin: 0 0 .4rem; }
  p.hint { color: var(--muted); font-size: .9rem; line-height: 1.6; margin: 0 0 1.75rem; }
  p.hint kbd {
    font-family: inherit; background: var(--card); border: 1px solid var(--line);
    border-radius: 5px; padding: .05rem .4rem;
  }
  .phrase {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: .8rem 1rem .95rem; margin-bottom: .7rem;
    transition: border-color .15s;
  }
  .phrase.ng { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .phrase .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: .5rem; }
  .phrase .label { color: var(--muted); font-size: .8rem; letter-spacing: .02em; }
  .badge {
    font-size: .78rem; font-variant-numeric: tabular-nums; letter-spacing: .03em;
    padding: .12rem .6rem; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent);
  }
  .phrase.ng .badge { background: var(--bad-soft); color: var(--bad); }
  input.syl {
    width: 100%; font-size: 1.25rem; letter-spacing: .12em; line-height: 1.5;
    padding: .5rem .7rem; color: var(--ink);
    background: transparent; border: none; border-bottom: 2px solid var(--line);
    border-radius: 0; outline: none; transition: border-color .15s;
  }
  input.syl:focus { border-bottom-color: var(--accent); }
  .phrase.ng input.syl { border-bottom-color: var(--bad); }
  footer {
    position: fixed; inset: auto 0 0 0;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid var(--line);
  }
  footer .inner {
    max-width: 44rem; margin: 0 auto; padding: .9rem 1.25rem;
    display: flex; align-items: center; gap: 1rem;
  }
  #summary { font-size: .88rem; color: var(--muted); flex: 1; }
  #summary.ng { color: var(--bad); }
  button {
    font-size: .95rem; font-weight: 600; letter-spacing: .02em;
    padding: .6rem 1.6rem; border-radius: 999px; border: none;
    background: var(--btn-bg); color: var(--btn-ink); cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .45; cursor: default; }
  #status { font-size: .88rem; color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <p class="hint"><kbd>スペース</kbd> で言葉の切れ目を調整してください — 例: 「あし た」→「あ した」。
右上の数字は <b>現在の音節数 / 必要ノート数</b> です。<kbd>Enter</kbd> で次の行に移動します。</p>
  <div id="rows"></div>
</main>
<footer><div class="inner">
  <span id="summary"></span>
  <span id="status"></span>
  <button id="submit">この内容で確定</button>
</div></footer>
<script>
const phrases = ${data};
const rows = document.getElementById("rows");
const summary = document.getElementById("summary");
const tokenize = (s) => s.split(/\\s+/u).filter((t) => t.length > 0);
const cards = phrases.map((p) => {
  const card = document.createElement("div");
  card.className = "phrase";
  card.innerHTML =
    '<div class="head"><span class="label"></span><span class="badge"></span></div>' +
    '<input class="syl" autocomplete="off" spellcheck="false">';
  card.querySelector(".label").textContent = p.label;
  const input = card.querySelector("input");
  input.value = p.syllables.join(" ");
  rows.appendChild(card);
  return { p, card, input };
});
function refresh() {
  let bad = 0;
  for (const { p, card, input } of cards) {
    const n = tokenize(input.value).length;
    const ok = n === p.noteCount;
    if (!ok) bad++;
    card.className = "phrase" + (ok ? "" : " ng");
    card.querySelector(".badge").textContent = n + " / " + p.noteCount;
  }
  summary.textContent = bad === 0
    ? "すべてのフレーズが一致しています"
    : bad + " 件のフレーズで音節数が合っていません";
  summary.className = bad === 0 ? "" : "ng";
}
cards.forEach(({ input }, i) => {
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && cards[i + 1]) cards[i + 1].input.focus();
  });
});
refresh();
document.getElementById("submit").addEventListener("click", async () => {
  const result = cards.map(({ p, input }) => ({
    label: p.label,
    syllables: tokenize(input.value),
  }));
  const res = await fetch("/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrases: result }),
  });
  document.getElementById("status").textContent =
    res.ok ? "送信しました ✓ チャットに戻って続けてください" : "送信に失敗しました";
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
