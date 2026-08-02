# svs-mcp Implementation Plan

An MCP server for Synthesizer V Studio (SV). Primary goal: **AI-driven input of lyrics and notes**.

## Decisions

| Item | Decision |
|---|---|
| Language | TypeScript (Node.js) + Lua (bridge script running inside SV) |
| Connection | File bridge (a Lua script resides in SV and communicates via files) |
| Scope | Lyrics + note CRUD, phoneme/pronunciation control |
| Time representation | Musical notation (measure/beat/note value) as primary; server converts to blicks |
| Target SV version | SV Studio V2 only |
| Platform | macOS only (no Windows support) |
| Distribution | Local build only (no npm publish) |

Out of scope (future work): adding/removing tracks, changing tempo/time signatures, parameter curve editing (pitch bend, vibrato, etc.), note group operations.

## Background: SV Scripting API Findings

- Scripts run inside the SV editor. Lua 5.4 / JavaScript (ES5.1, Duktape).
- **No network API.** Lua has the standard `io` / `os` libraries, so file-based communication is the only practical bridge.
- Time unit is the blick. `SV.QUARTER = 705600000` (one quarter note).
- Note API: `getLyrics/setLyrics`, `getPhonemes/setPhonemes` (space-separated string; empty string when unspecified), `getPitch/setPitch` (MIDI number), `getOnset/getDuration/setTimeRange` (blicks), `getAttributes/setAttributes`, `getLanguageOverride/setLanguageOverride`.
- `SV.getPhonemesForGroup(groupRef)` returns the **phonemes actually used for synthesis** (converter output) for all notes in a group. Per-note `getPhonemes()` only returns user-specified overrides.
- Async via `SV.setTimeout(ms, callback)` — this drives the polling loop. The script stays resident until `SV.finish()` is called.
- Tempo and time signatures come from `TimeAxis` (`getAllTempoMarks`, `getAllMeasureMarks`).

The reference implementation [ocadaruma/mcp-svstudio](https://github.com/ocadaruma/mcp-svstudio) uses the same file-bridge approach, but: its tool set is thin (add/edit/list only — no delete, no lyric flow-in, no phonemes), it has no request IDs so stale responses can be misread, and it uses raw ticks for time. This project addresses all of these.

A local mirror of the scripting manual lives in `tmp/sv-scripting-docs/` — consult it instead of fetching the site.

## Architecture

```
AI client (Claude, etc.)
   │ MCP (stdio)
   ▼
MCP server (Node.js / TypeScript)
   │ write command file → poll response file
   ▼
~/.svs-mcp/bridge/  (request.json / response.json)
   ▲
   │ polling loop via SV.setTimeout (100ms)
SVSMCPBridge.lua (resident inside SV Studio)
```

### Bridge protocol

- Communication directory: `~/.svs-mcp/bridge/` (overridable via `SVS_MCP_BRIDGE_DIR`).
- Request: `{ "id": "<seq + random>", "action": "...", "params": {...} }`
- Response: `{ "id": "<same id>", "ok": true, "result": {...} }` or `{ "id", "ok": false, "error": "..." }`
- **Matching `id` is required**, preventing stale responses from being misread.
- Writes go to a temp file followed by rename, so a half-written JSON file is never parsed.
- Timeout: 10 seconds. On timeout, the error message tells the user to check that the bridge script is running in SV.
- The Lua side embeds a JSON encoder/decoder (bundle rxi/json.lua).
- On startup the bridge clears leftover request/response files, then writes a `bridge.json` readiness marker (removed again on shutdown). Clients that start the bridge should wait for this marker before sending the first request, to avoid racing the cleanup.
- Shutdown: a `{"action": "shutdown"}` request calls `SV.finish()`. A separate Stop script is also shipped for stopping from the SV side.

### Musical time conversion (server side)

- Input format: `{ "measure": 4, "beat": 1, "offset": "1/16" }` (measure/beat are 1-based; offset optional). Note values are strings such as `"1/4"`, `"1/8"`, `"1/8."` (dotted), `"1/12"` (triplet), or a numeric beat count.
- Conversion requires time signatures → each tool call queries the bridge for time-axis data before converting (no persistent cache, so editor-side changes are always respected).
- Read tools (`get_notes` etc.) return both musical notation and blicks so the AI can read positions easily.

### Groups and singers (verified on SV Studio 2 Pro 2.2.1)

Empirical findings that shape the tool design:

- Measure marks are **0-based** in the scripting API; the public interface is 1-based.
- **The singer is attached per note group.** Notes placed in a track's *main* group are visible in the piano roll but are **not synthesized** (silent).
- Groups created via script (`SV:create("NoteGroup")` + `addGroupReference`), including groups on script-created tracks, inherit the default singer and **do sing**.
- There is **no API to select or query the singer** (voice database); `NoteGroupReference#getVoice/setVoice` only handle parameters (loudness, tension, etc.). Singer selection stays in the SV UI.
- Note onsets inside a group are relative to the reference's time offset; the bridge always converts to absolute project positions.

Consequently: `insert_notes` defaults to the first non-main group and auto-creates one when the track has none; the main group is never targeted implicitly. `add_track` and `create_group` tools exist (originally out of scope, promoted during verification).

### Note addressing

- SV notes have no stable IDs. Notes are addressed by **onset-order index** within the track's main group (`track:getGroupReference(0)`).
- Because inserts/deletes shift indices, **every mutating tool returns a fresh snapshot of the affected range**. The AI always operates on the latest snapshot.

## MCP Tools

Read:

| Tool | Description |
|---|---|
| `ping` | Bridge liveness check. On failure, returns setup instructions |
| `get_project_info` | Project name/path, tempo, time signatures, track list (name, note count, voice) |
| `get_notes` | Notes of a track, filterable by measure range. Returns lyrics, pitch (MIDI number and note name like C4), onset/duration (musical + blicks), user-specified phonemes |
| `get_phonemes` | Actual synthesis phonemes via `SV.getPhonemesForGroup` (for pronunciation checks) |

Write:

| Tool | Description |
|---|---|
| `insert_notes` | Batch note insertion. Per note: lyrics, pitch (note name `"C4"` or MIDI number), onset (musical), duration (note value). Supports relative placement ("right after the previous note") for sequential input |
| `update_notes` | Batch edit of lyrics/pitch/timing by index |
| `delete_notes` | Delete by indices or range |
| `set_lyrics` | **Lyric flow-in**: start index + array of syllables, assigned to consecutive notes. Japanese: one kana per note; `-` extends the previous vowel (SV convention passed through) |
| `set_phonemes` | Per-note phoneme override (space-separated, e.g. `"k a"`). Empty string resets |
| `set_language` | Per-note language override (for mixed Japanese/English songs) |

Tool descriptions embed SV-specific conventions (one kana per note for Japanese, meaning of `-`, phoneme notation) so an AI can use them correctly without prior knowledge.

## Project Layout

```
svs-mcp/
├── package.json          # @modelcontextprotocol/sdk, zod (schemas), vitest
├── tsconfig.json
├── src/
│   ├── index.ts          # Entry point. Starts the MCP server (stdio)
│   ├── bridge.ts         # File-protocol client (write/poll/timeout)
│   ├── time.ts           # Musical notation <-> blicks conversion (tempo/time-signature aware)
│   └── tools/            # Tool definitions (one file per tool family)
│       ├── read.ts
│       ├── notes.ts
│       └── lyrics.ts
├── sv-scripts/
│   ├── SVSMCPBridge.lua      # Resident bridge (json.lua embedded at build time)
│   └── SVSMCPBridgeStop.lua  # Stop script
├── test/
│   ├── time.test.ts      # Unit tests for conversion logic
│   └── bridge.test.ts    # Integration tests against a fake bridge (Node emulator of the Lua side)
└── docs/
    └── plan.md
```

## Milestones

1. **M1 — Foundation**: scaffolding, bridge protocol (TS + Lua sides), `ping` / `get_project_info`. Verify end-to-end with a real SV instance.
2. **M2 — Reading and note input**: `get_notes` / `insert_notes` and time conversion (`time.ts`). Unit tests.
3. **M3 — Editing and lyric flow-in**: `update_notes` / `delete_notes` / `set_lyrics`.
4. **M4 — Pronunciation control**: `get_phonemes` / `set_phonemes` / `set_language`.
5. **M5 — Polish**: README (setup: place Lua scripts → run in SV → configure MCP client), error message quality.
