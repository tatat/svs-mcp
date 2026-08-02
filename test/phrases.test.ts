import { describe, expect, it } from "vitest";
import { detectPhrases } from "../src/phrases.js";
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
