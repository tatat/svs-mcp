# svs-mcp

An MCP server for Synthesizer V Studio (SV). Primary goal: AI-driven input of lyrics and notes.

The full design lives in `docs/plan.md` — read it before making changes. Keep it up to date when
decisions change; it is the source of truth for scope and architecture.

## Status

Implemented and verified against SV Studio 2 Pro 2.2.1 (all planned milestones plus phrase
analysis, time signature editing, and a browser-based lyrics editor). See README.md for the
tool list and docs/lyrics-workflow.md / docs/meter-inference.md for the workflows.

## Fixed decisions

- Language: TypeScript (Node.js) for the MCP server, Lua for the bridge script that runs inside SV.
- Transport to SV: file bridge under `~/.svs-mcp/bridge/` (SV's scripting API has no network access).
- Target: SV Studio **V2 only**, **macOS only**, **local build only** (not published to npm).
- Scope: lyric/note CRUD and phoneme/pronunciation control. Tracks, tempo, time signatures and
  parameter curves are out of scope.

## Conventions

- Documentation, code comments and commit messages are written in **English**.
- Musical time (measure/beat/note value) is the public interface; blicks (`SV.QUARTER = 705600000`)
  are an internal detail of the server.
- Notes are addressed by onset-order index, so every mutating tool returns a fresh snapshot of the
  affected range.
- SV Studio 2 attaches the singer per note group; notes in a track's main group are NOT synthesized.
  Tools therefore default to the first non-main group (auto-created on insert when missing). There is
  no scripting API for singer selection. See "Groups and singers" in docs/plan.md.

## SV scripting reference

A local mirror of the SV scripting manual is in `tmp/sv-scripting-docs/` (gitignored). Consult those
HTML files instead of fetching `resource.dreamtonics.com` repeatedly.
