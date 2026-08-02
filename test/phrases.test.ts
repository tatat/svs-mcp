import { describe, expect, it } from "vitest";
import { detectPhrases, labelPhraseShapes } from "../src/phrases.js";
import { QUARTER } from "../src/time.js";

const EIGHTH = QUARTER / 2;

// Helper: build consecutive notes from [onsetQ, durationQ] pairs (in quarters).
const notes = (spec: Array<[number, number]>) =>
  spec.map(([onset, duration], i) => ({
    index: i + 1,
    onset: onset * QUARTER,
    duration: duration * QUARTER,
  }));

describe("detectPhrases", () => {
  it("returns an empty list for no notes", () => {
    expect(detectPhrases([], EIGHTH, 4 * QUARTER)).toEqual([]);
  });

  it("keeps a continuous line as one phrase", () => {
    const phrases = detectPhrases(
      notes([
        [0, 1],
        [1, 1],
        [2, 2],
      ]),
      EIGHTH,
      4 * QUARTER,
    );
    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({ firstNote: 1, lastNote: 3, noteCount: 3 });
  });

  it("splits at rests of at least the threshold", () => {
    const phrases = detectPhrases(
      notes([
        [0, 1],
        [1, 0.5], // ends at 1.5q; next starts at 2q -> eighth rest
        [2, 1],
        [3, 1],
      ]),
      EIGHTH,
      4 * QUARTER,
    );
    expect(phrases).toHaveLength(2);
    expect(phrases[0]).toMatchObject({ firstNote: 1, lastNote: 2 });
    expect(phrases[1]).toMatchObject({
      firstNote: 3,
      lastNote: 4,
      gapBeforeBlick: EIGHTH,
      sectionBreakBefore: false,
    });
  });

  it("ignores gaps smaller than the threshold", () => {
    const phrases = detectPhrases(
      notes([
        [0, 0.9],
        [1, 1],
      ]),
      EIGHTH,
      4 * QUARTER,
    );
    expect(phrases).toHaveLength(1);
  });

  it("labels repeated melodies with the same shape letter", () => {
    // Two identical phrases around a different one: A, B, A.
    const seq = [
      { index: 1, onset: 0, duration: QUARTER, pitch: 60 },
      { index: 2, onset: QUARTER, duration: QUARTER, pitch: 62 },
      { index: 3, onset: 4 * QUARTER, duration: QUARTER, pitch: 65 },
      { index: 4, onset: 8 * QUARTER, duration: QUARTER, pitch: 60 },
      { index: 5, onset: 9 * QUARTER, duration: QUARTER, pitch: 62 },
    ];
    const phrases = detectPhrases(seq, EIGHTH, 16 * QUARTER);
    expect(phrases).toHaveLength(3);
    expect(labelPhraseShapes(phrases, seq)).toEqual(["A", "B", "A"]);
  });

  it("marks long rests as section breaks", () => {
    const phrases = detectPhrases(
      notes([
        [0, 1],
        [6, 1], // 5-quarter rest
      ]),
      EIGHTH,
      4 * QUARTER,
    );
    expect(phrases).toHaveLength(2);
    expect(phrases[1]).toMatchObject({ gapBeforeBlick: 5 * QUARTER, sectionBreakBefore: true });
  });
});
