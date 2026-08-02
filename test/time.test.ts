import { describe, expect, it } from "vitest";
import {
  QUARTER,
  WHOLE,
  blickToMusical,
  blickToNoteValue,
  formatPitch,
  musicalToBlick,
  noteValueToBlick,
  parsePitch,
  type TimeSignature,
} from "../src/time.js";

const FOUR_FOUR: TimeSignature[] = [
  { measure: 0, positionBlick: 0, numerator: 4, denominator: 4 },
];

// 4/4 for measures 1-2 (public numbering), then 3/4 from measure 3.
const WITH_CHANGE: TimeSignature[] = [
  { measure: 0, positionBlick: 0, numerator: 4, denominator: 4 },
  { measure: 2, positionBlick: 8 * QUARTER, numerator: 3, denominator: 4 },
];

describe("noteValueToBlick", () => {
  it("parses plain fractions", () => {
    expect(noteValueToBlick("1/4")).toBe(QUARTER);
    expect(noteValueToBlick("1/8")).toBe(QUARTER / 2);
    expect(noteValueToBlick("3/16")).toBe((3 * WHOLE) / 16);
    expect(noteValueToBlick("1/12")).toBe(WHOLE / 12);
  });

  it("parses dotted values", () => {
    expect(noteValueToBlick("1/8.")).toBe(QUARTER * 0.75);
    expect(noteValueToBlick("1/4..")).toBe(QUARTER * 1.75);
  });

  it("treats numbers as quarter counts", () => {
    expect(noteValueToBlick(2)).toBe(2 * QUARTER);
    expect(noteValueToBlick(0.5)).toBe(QUARTER / 2);
  });

  it("rejects garbage", () => {
    expect(() => noteValueToBlick("fast")).toThrow(/Invalid note value/);
    expect(() => noteValueToBlick("0/4")).toThrow(/Invalid note value/);
    expect(() => noteValueToBlick(-1)).toThrow(/Invalid note value/);
  });
});

describe("blickToNoteValue", () => {
  it("formats clean fractions and dots", () => {
    expect(blickToNoteValue(QUARTER)).toBe("1/4");
    expect(blickToNoteValue(QUARTER / 2)).toBe("1/8");
    expect(blickToNoteValue(QUARTER * 0.75)).toBe("1/8.");
    expect(blickToNoteValue(WHOLE / 12)).toBe("1/12");
  });

  it("falls back to quarter counts", () => {
    expect(blickToNoteValue(QUARTER + 1)).toMatch(/q$/);
  });
});

describe("musicalToBlick", () => {
  it("converts positions in 4/4", () => {
    expect(musicalToBlick({ measure: 1, beat: 1 }, FOUR_FOUR)).toBe(0);
    expect(musicalToBlick({ measure: 1, beat: 3 }, FOUR_FOUR)).toBe(2 * QUARTER);
    expect(musicalToBlick({ measure: 3, beat: 1 }, FOUR_FOUR)).toBe(8 * QUARTER);
    expect(musicalToBlick({ measure: 2, beat: 2, offset: "1/16" }, FOUR_FOUR)).toBe(
      5 * QUARTER + WHOLE / 16,
    );
  });

  it("honors time signature changes", () => {
    // Measure 3 starts the 3/4 section at 8 quarters.
    expect(musicalToBlick({ measure: 3, beat: 1 }, WITH_CHANGE)).toBe(8 * QUARTER);
    // Measure 4 = 8 + 3 quarters.
    expect(musicalToBlick({ measure: 4, beat: 1 }, WITH_CHANGE)).toBe(11 * QUARTER);
    expect(musicalToBlick({ measure: 4, beat: 3 }, WITH_CHANGE)).toBe(13 * QUARTER);
  });

  it("rejects out-of-range beats and measures", () => {
    expect(() => musicalToBlick({ measure: 0, beat: 1 }, FOUR_FOUR)).toThrow(/measure/i);
    expect(() => musicalToBlick({ measure: 3, beat: 4 }, WITH_CHANGE)).toThrow(/3\/4/);
    expect(() => musicalToBlick({ measure: 1, beat: 0 }, FOUR_FOUR)).toThrow(/beat/i);
  });
});

describe("blickToMusical", () => {
  it("round-trips positions", () => {
    for (const position of [
      { measure: 1, beat: 1 },
      { measure: 2, beat: 4 },
      { measure: 3, beat: 1 },
      { measure: 5, beat: 2 },
    ]) {
      const blick = musicalToBlick(position, WITH_CHANGE);
      const back = blickToMusical(blick, WITH_CHANGE);
      expect({ measure: back.measure, beat: back.beat }).toEqual(position);
      expect(back.offsetBlick).toBe(0);
    }
  });

  it("reports sub-beat offsets in the display", () => {
    const blick = musicalToBlick({ measure: 2, beat: 2, offset: "1/16" }, FOUR_FOUR);
    const out = blickToMusical(blick, FOUR_FOUR);
    expect(out.display).toBe("2.2+1/16");
  });
});

describe("pitch", () => {
  it("parses note names and MIDI numbers", () => {
    expect(parsePitch("C4")).toBe(60);
    expect(parsePitch("A4")).toBe(69);
    expect(parsePitch("F#3")).toBe(54);
    expect(parsePitch("Bb5")).toBe(82);
    expect(parsePitch(72)).toBe(72);
  });

  it("formats MIDI numbers", () => {
    expect(formatPitch(60)).toBe("C4");
    expect(formatPitch(54)).toBe("F#3");
  });

  it("rejects invalid pitches", () => {
    expect(() => parsePitch("H2")).toThrow(/Invalid pitch/);
    expect(() => parsePitch(200)).toThrow(/0-127/);
    expect(() => parsePitch(1.5)).toThrow(/0-127/);
  });
});
