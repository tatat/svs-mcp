# Lyric flow-in workflow

How to put lyrics on a melody imported into SV Studio (typically MIDI exported from
another DAW, arranged next to a WAV backing track). The mechanical parts are tools;
the musical judgment stays with the AI + user in each session, because it differs
per song — do not hard-code one song's interpretation.

## Steps

1. **Survey** — `get_project_info` to find the melody track/group (MIDI imports land
   in a non-main group, which is the singing kind).
2. **Analyze** — `get_phrases` on that track. Tune `restThreshold` to the song
   (staccato melodies need a larger value such as `"1/2"`; legato ones work with the
   default `"1/8"`). Read the result as:
   - `noteCount` per phrase = syllable slots to fill
   - `sectionBreakBefore` = likely verse/chorus boundaries
   - `shape` = phrases with the same letter repeat the same melody, and usually
     carry the same or parallel lyric lines
3. **Get lyrics** — ask the user for the lyrics as text, ideally with sections
   separated by blank lines. Match lyric sections to melodic sections.
4. **Align** — split lyrics into syllables and map them to phrases. Present the
   mapping (including every judgment call) BEFORE or right after applying, so the
   user can correct by ear. Typical judgment calls that vary per song:
   - where to place melisma (`-`) when notes > syllables
   - which syllables to cram onto one note when syllables > notes
   - how repeated shapes distribute repeated lines
5. **Apply** — `set_lyrics` per phrase (`startIndex` = the phrase's `firstNote`),
   or one call for the whole track when the mapping tiles all notes.
6. **QA** — `get_phonemes`; fix pronunciation with `set_phonemes` (readings SV gets
   wrong) or `set_language` (foreign words). Then have the user listen — the ear is
   the final judge.

## Japanese syllable guidelines (defaults, not rules)

- One kana (mora) per note; small-kana clusters (きゃ, しょ) stay on one note.
- っ merges into the preceding note's lyric (かった → か / かっ+た depending on
  note count); SV renders it as a closure (`cl`).
- A held vowel or ー becomes `-` on its own note, or simply a longer note.
- Cramming two morae on one note (いつ, ひと, もう) is legal and common on short
  pickup notes; SV converts all of them.
- Particles keep their sung reading: は→わ is handled by writing わ, but を is
  already sung as `o` by SV.

`-` notes show empty computed phonemes in `get_phonemes`; that is normal.

When the SV grid doesn't match the music's real meter (common with imported
MIDI), index-based steps above still work; see
[meter-inference.md](meter-inference.md) for figuring out the actual meter from
note data.
