/**
 * Phrase detection over a note sequence.
 *
 * A phrase break is a rest (gap between one note's end and the next note's
 * onset) of at least `restThresholdBlick`. A gap of at least
 * `sectionThresholdBlick` additionally marks a likely section boundary
 * (verse/chorus etc.). Pure function, unit-tested without SV.
 */

export interface PhraseNoteInput {
  index: number;
  onset: number;
  duration: number;
}

export interface Phrase {
  /** 1-based phrase number. */
  index: number;
  /** Note index range (as reported by get_notes), inclusive. */
  firstNote: number;
  lastNote: number;
  noteCount: number;
  onsetBlick: number;
  endBlick: number;
  /** Rest before this phrase in blicks; null for the first phrase. */
  gapBeforeBlick: number | null;
  /** True when the preceding rest suggests a section boundary. */
  sectionBreakBefore: boolean;
}

export function detectPhrases(
  notes: PhraseNoteInput[],
  restThresholdBlick: number,
  sectionThresholdBlick: number,
): Phrase[] {
  if (notes.length === 0) return [];

  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  const phrases: Phrase[] = [];
  let current: PhraseNoteInput[] = [sorted[0]!];
  let previousEnd = sorted[0]!.onset + sorted[0]!.duration;
  let gapBefore: number | null = null;

  const flush = (nextGap: number | null) => {
    const first = current[0]!;
    const last = current[current.length - 1]!;
    phrases.push({
      index: phrases.length + 1,
      firstNote: first.index,
      lastNote: last.index,
      noteCount: current.length,
      onsetBlick: first.onset,
      endBlick: last.onset + last.duration,
      gapBeforeBlick: gapBefore,
      sectionBreakBefore: gapBefore !== null && gapBefore >= sectionThresholdBlick,
    });
    gapBefore = nextGap;
  };

  for (const note of sorted.slice(1)) {
    const gap = note.onset - previousEnd;
    if (gap >= restThresholdBlick) {
      flush(gap);
      current = [note];
    } else {
      current.push(note);
    }
    previousEnd = Math.max(previousEnd, note.onset + note.duration);
  }
  flush(null);
  return phrases;
}
