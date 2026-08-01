# svs-mcp

An MCP server for Synthesizer V Studio (SV). Primary goal: AI-driven input of lyrics and notes.

The full design lives in `docs/plan.md` — read it before making changes. Keep it up to date when
decisions change; it is the source of truth for scope and architecture.

## Status

Design phase. No source code exists yet; the layout described in `docs/plan.md` is the target.

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

## SV scripting reference

A local mirror of the SV scripting manual is in `tmp/sv-scripting-docs/` (gitignored). Consult those
HTML files instead of fetching `resource.dreamtonics.com` repeatedly.
