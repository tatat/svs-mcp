import { describe, expect, it } from "vitest";
import {
  detectionWindow,
  flatCurvePoints,
  planFlattenCurve,
  steadyWindow,
  wobbleStats,
} from "../src/pitchWobble.js";
import { QUARTER } from "../src/time.js";

describe("steadyWindow", () => {
  it("skips the transitions at both ends of a half note", () => {
    const w = steadyWindow({ onset: 0, duration: 2 * QUARTER });
    expect(w.start).toBe(QUARTER / 2); // 25% capped at an eighth note
    expect(w.end).toBe(2 * QUARTER - QUARTER / 4); // 15% capped at a sixteenth
  });

  it("honors explicit offsets", () => {
    const w = steadyWindow({ onset: 1000, duration: QUARTER }, 10, 20);
    expect(w).toEqual({ start: 1010, end: 1000 + QUARTER - 20 });
  });
});

describe("wobbleStats", () => {
  const interval = QUARTER / 32;
  const samplesOf = (fn: (t: number) => number | null, n: number) => ({
    startBlick: 0,
    intervalBlick: interval,
    values: Array.from({ length: n }, (_, i) => fn(i * interval)),
  });

  // One vibrato period = a quarter / 4 here; smooth over exactly one period.
  const period = QUARTER / 4;

  it("measures a sinusoidal wobble around the target pitch", () => {
    // +-20 cents, 4 cycles per quarter, over two quarters.
    const samples = samplesOf((t) => 60 + 0.2 * Math.sin((2 * Math.PI * t) / period + 0.3), 65);
    const stats = wobbleStats(samples, { start: 0, end: 2 * QUARTER }, 60, period)!;
    expect(stats.wobbleCents).toBeGreaterThan(36);
    expect(stats.wobbleCents).toBeLessThan(46);
    expect(Math.abs(stats.meanCents)).toBeLessThan(3);
    // 8 cycles; window edges may add or drop a crossing.
    expect(Math.round(stats.crossings / 2)).toBeGreaterThanOrEqual(7);
    expect(Math.round(stats.crossings / 2)).toBeLessThanOrEqual(9);
  });

  it("does not count a slow glide as wobble", () => {
    // Steady 100-cent rise over two quarters (a transition, not vibrato).
    const samples = samplesOf((t) => 60 + t / (2 * QUARTER), 65);
    const stats = wobbleStats(samples, { start: 0, end: 2 * QUARTER }, 60, period)!;
    expect(stats.driftCents).toBeGreaterThan(80);
    expect(Math.round(stats.crossings / 2)).toBeLessThanOrEqual(1);
  });

  it("locates where a late vibrato starts", () => {
    const samples = samplesOf(
      (t) => 60 + (t < QUARTER ? 0 : 0.2 * Math.sin((2 * Math.PI * t) / period + 0.3)),
      65,
    );
    const stats = wobbleStats(samples, { start: 0, end: 2 * QUARTER }, 60, period)!;
    expect(stats.wobbleStart).toBeGreaterThanOrEqual(QUARTER - period / 2);
  });

  it("ignores samples outside the window and null samples", () => {
    const samples = samplesOf((t) => (t < QUARTER / 2 ? 61 : t < QUARTER ? 60 : null), 40);
    const stats = wobbleStats(samples, { start: QUARTER / 2, end: 2 * QUARTER }, 60, period)!;
    expect(stats.wobbleCents).toBe(0);
    expect(stats.samples).toBe(16);
  });

  it("returns undefined with too few samples", () => {
    expect(wobbleStats(samplesOf(() => 60, 2), { start: 0, end: QUARTER }, 60, period)).toBeUndefined();
  });
});

describe("flatCurvePoints", () => {
  it("spans the window exactly at a constant pitch", () => {
    const points = flatCurvePoints({ start: 0, end: QUARTER / 4 }, 64, QUARTER / 16);
    expect(points.map((p) => p[0])).toEqual([0, QUARTER / 16, QUARTER / 8, (3 * QUARTER) / 16, QUARTER / 4]);
    expect(points.every((p) => p[1] === 64)).toBe(true);
  });

  it("returns nothing for an empty window", () => {
    expect(flatCurvePoints({ start: 10, end: 10 }, 60)).toEqual([]);
  });
});

describe("detectionWindow", () => {
  it("runs to the note end when a rest follows", () => {
    const note = { onset: 0, duration: 2 * QUARTER };
    expect(detectionWindow(note, QUARTER).end).toBe(2 * QUARTER);
    expect(detectionWindow(note, 0).end).toBe(2 * QUARTER - QUARTER / 4);
  });
});

describe("planFlattenCurve", () => {
  const note = { onset: 0, duration: 2 * QUARTER, pitch: 68 };
  const smooth = QUARTER / 4;

  it("holds flat from before the wobble and falls into a following rest", () => {
    const plan = planFlattenCurve(note, {
      wobbleStart: 1.5 * QUARTER,
      smoothBlick: smooth,
      restAfter: QUARTER,
    });
    expect(plan.release).toBe(true);
    expect(plan.start).toBe(1.5 * QUARTER - smooth / 2);
    expect(plan.holdEnd).toBe(2 * QUARTER - QUARTER / 10);
    expect(plan.end).toBe(2 * QUARTER + QUARTER / 4);
    const flat = plan.points.filter(([t]) => t <= plan.holdEnd);
    expect(flat.every(([, p]) => p === 68)).toBe(true);
    // Monotonic fall ending 35 cents down.
    const tail = plan.points.filter(([t]) => t >= plan.holdEnd).map(([, p]) => p);
    for (let i = 1; i < tail.length; i++) expect(tail[i]!).toBeLessThanOrEqual(tail[i - 1]!);
    expect(plan.points[plan.points.length - 1]).toEqual([plan.end, 67.65]);
  });

  it("stops short before a following note and never runs into it", () => {
    const plan = planFlattenCurve(note, { smoothBlick: smooth, restAfter: 0 });
    expect(plan.release).toBe(false);
    expect(plan.end).toBe(2 * QUARTER - QUARTER / 8);
    const short = planFlattenCurve(note, { smoothBlick: smooth, restAfter: QUARTER / 4 });
    expect(short.end).toBeLessThanOrEqual(2 * QUARTER + QUARTER / 4 - QUARTER / 8);
  });

  it("honors an explicit start offset", () => {
    const plan = planFlattenCurve(note, {
      startOffset: QUARTER,
      wobbleStart: 0.5 * QUARTER,
      smoothBlick: smooth,
      restAfter: Number.POSITIVE_INFINITY,
    });
    expect(plan.start).toBe(QUARTER);
  });
});
