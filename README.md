# svs-mcp

An MCP (Model Context Protocol) server for **Synthesizer V Studio 2 Pro**, focused on
AI-driven input of lyrics and notes: compose melodies, flow lyrics onto them, and
fine-tune pronunciation — all from an AI client such as Claude.

- macOS + SV Studio 2 Pro only. Local build only (not published to npm).
- Design notes and background live in [docs/plan.md](docs/plan.md).

## How it works

SV's scripting API has no network access, so a small Lua script runs inside SV Studio
and exchanges JSON files with the MCP server:

```
AI client (Claude, etc.)
   │ MCP (stdio)
   ▼
svs-mcp server (Node.js)
   │ request.json / response.json in ~/.svs-mcp/bridge/
   ▼
SVSMCPBridge.lua (resident script inside SV Studio, polls every 100ms)
```

Requests carry unique IDs (stale responses are discarded) and all file writes are
atomic (temp file + rename).

## Setup

Requirements: Node.js 20+, Synthesizer V Studio 2 Pro on macOS.

```sh
npm install
npm run build
npm run install-sv   # copies the bridge scripts into SV's scripts folder
```

Then, in SV Studio:

1. Run **Scripts > Rescan** (or restart SV Studio).
2. Run **Scripts > SVS MCP > "SVS MCP Bridge: Start"**. A dialog confirms the bridge
   is running; it keeps running in the background.

Finally, register the server with your MCP client:

```json
{
  "mcpServers": {
    "svs-mcp": {
      "command": "node",
      "args": ["/path/to/svs-mcp/dist/index.js"]
    }
  }
}
```

To verify the setup without an MCP client, run `npm run ping` — it prints SV's
host info when the bridge answers, or setup guidance when it doesn't (exit 1),
which also makes the whole setup scriptable for an AI agent: only the two
Scripts-menu clicks above need a human.

To stop the bridge, run **"SVS MCP Bridge: Stop"** from the Scripts menu.
To remove everything, `npm run uninstall-sv`.

## Tools

| Tool | Purpose |
|---|---|
| `ping` | Check the bridge is alive; returns SV host info |
| `get_project_info` | Project overview: tempo, time signatures, tracks, groups, mixer state |
| `get_notes` | List notes (lyrics, pitch, position) of a track/group, filterable by measure |
| `add_track` | Add a track |
| `create_group` | Add a note group to a track |
| `insert_notes` | Insert notes: lyrics + pitch (`"C4"`) + musical position (measure/beat) + note value (`"1/8"`) |
| `update_notes` | Edit lyrics/pitch/timing of existing notes by index |
| `delete_notes` | Delete notes by index |
| `set_lyrics` | Flow lyrics (one syllable per note) onto an existing melody |
| `get_phrases` | Analyze a melody into phrases/sections with repetition (shape) labels |
| `set_time_signature` | Add/update/remove time signature marks (align SV's grid with the music) |
| `open_lyrics_editor` | Browser page for the user to adjust syllable boundaries before applying |
| `get_lyrics_editor_result` | Fetch the user-edited syllable plan from the editor |
| `get_phonemes` | Inspect the phonemes SV will actually sing |
| `set_phonemes` | Override phonemes per note (`"k a"`); empty string resets |
| `set_language` | Per-note language override for mixed-language lyrics |

Positions and durations use musical notation (1-based measures/beats, note values
like `1/8` or dotted `1/8.`); the server converts to SV's internal blicks.
Japanese lyrics take one kana per note; `-` extends the previous vowel.

For putting lyrics on an imported MIDI melody, see
[docs/lyrics-workflow.md](docs/lyrics-workflow.md).

## Important: groups and singers

In SV Studio 2 the **singer is attached per note group**, and notes placed in a
track's *main* group are **not synthesized** (they appear in the piano roll but stay
silent). Therefore:

- `insert_notes` targets the first non-main group by default and auto-creates a
  group when the track has none.
- New tracks/groups inherit SV's default singer. There is **no scripting API for
  singer selection**, so if a group has no singer, pick one in the SV UI (select a
  note of the group, then use the Voice panel).

## Troubleshooting

- **Tool calls time out** — the bridge is probably not running. Run
  "SVS MCP Bridge: Start" in SV Studio. Only one MCP server instance should talk to
  one SV instance.
- **Notes appear but don't sound** — check that the notes are in a non-main group
  (`get_project_info` shows the groups) and that the group has a singer assigned in
  the Voice panel. Also check track/group mute states, which `get_project_info`
  reports.
- **Wrong pronunciation** — inspect with `get_phonemes`, then correct with
  `set_phonemes` or `set_language`.

## Development

```sh
npm test        # unit + protocol tests + e2e against the real Lua bridge (needs `lua` on PATH)
npm run build   # tsc
```

`test/sv-stub.lua` emulates the SV host so the actual bridge script can be tested
without SV Studio. After changing `sv-scripts/`, re-run `npm run install-sv` and
restart the bridge from SV's Scripts menu.

## License

MIT. Bundles [rxi/json.lua](https://github.com/rxi/json.lua) (MIT) inside the bridge
script.
