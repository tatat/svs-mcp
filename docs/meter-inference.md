# Inferring the actual meter from note data

SV's grid often stays at 4/4 even when the music isn't (MIDI imports don't always
carry time signatures). Index-based operations don't care, but when you want to
understand a song's real meter — or eventually write correct measure marks back —
the meter can be inferred from note onsets alone. Method verified on a real
project (4/4 grid, actual music partly in 5-quarter cycles and partly 3/4).

## Signals, in order of usefulness

1. **Phrase-start deltas.** Take phrase onsets (from `get_phrases`, or a gap scan
   over `get_notes`) in quarter-note units and look at consecutive differences.
   A constant delta is one phrase per cycle: deltas of 5 mean 5-quarter cycles
   (5/4, or 3/4+2/4 alternation), deltas of 3 mean 3/4, etc.
   Caveat: pickups (anacrusis) shift phrase starts off the downbeat, so deltas
   give the cycle *length* but not the bar-line *phase*.

2. **Onset histogram modulo candidate cycle lengths.** For a region, bucket
   integer-quarter onsets by `onset mod m` for m = 3, 4, 5, ... The real cycle
   length shows strong structure (empty or dominant residue classes); wrong
   candidates come out flat. Example from the verified project, 104-note section:
   `mod 3 → 0/32/32` (one residue completely empty = strong 3/4 structure) while
   `mod 4 → 16/16/16/16` and `mod 5` were flat — the section is 3/4.

3. **Duration weighting.** Long notes and phrase-final notes tend to sit on or
   just before strong beats; weight the histogram by duration when plain counts
   are ambiguous.

## Limits

- A sparse vocal line can't always resolve the internal grouping of a cycle
  (3+2 vs 2+3 vs plain 5/4) when it only sings part of each cycle. An
  instrument/drum MIDI track resolves this, but audio-only backing tracks have
  no notes to analyze.
- Humanized/off-grid MIDI produces fractional offsets (`+7/32` etc.); round to
  the grid or filter to integer-quarter onsets before the histogram.
- The histogram gives the cycle length; the phase (where bar lines fall) comes
  from which residue classes are occupied, interpreted with musical judgment.

## Writing the result back

The `set_time_signature` tool writes measure marks so SV's grid matches the
music. Keep the inference itself as an in-session analysis — per-song judgment
applies, as with lyric alignment — and set the marks before doing any
position-based work, since they change how measure/beat positions map to time.
