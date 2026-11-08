/**
 * Residual pitch wobble detection on SV's computed (AI-generated) pitch.
 *
 * Even with the Vibrato Envelope at 0, SV's pitch model can leave a wavering
 * pitch on sustained notes. Users flatten these by drawing a straight pen-tool
 * pitch curve over the note. This module measures, per note, how far the
 * computed pitch strays from the written note pitch inside the note's
 * "steady" window (excluding the transitions at both ends), and builds the
 * flat curve that overrides it.
 */

import { QUARTER } from "./time.js";

export interface WobbleNote {
  index: number;
  lyrics: string;
  pitch: number;
  onset: number;
  duration: number;
}

export interface PitchSamples {
  startBlick: number;
  intervalBlick: number;
  /** Sung pitch in semitones, or null where SV has no pitch. */
  values: Array<number | null>;
}

export interface Window {
  start: number;
  end: number;
}

/**
 * The part of a note that should sit on the written pitch: skip the attack
 * transition at the head and the release/next-note transition at the tail.
 */
export function steadyWindow(
  note: Pick<WobbleNote, "onset" | "duration">,
  head?: number,
  tail?: number,
): Window {
  const d = note.duration;
  const h = head ?? Math.min(Math.max(d * 0.25, QUARTER / 8), QUARTER / 2, d * 0.4);
  const t = tail ?? Math.min(d * 0.15, QUARTER / 4);
  return { start: note.onset + h, end: note.onset + d - t };
}

/** Rest long enough after a note for a release tail (instead of a transition). */
export const MIN_REST_FOR_RELEASE = QUARTER / 2;

/**
 * Window in which to look for wobble: the steady window, but running up to
 * the note end when a rest follows (residual vibrato tends to sit at the very
 * end of a held note), since there is no transition to the next note there.
 */
export function detectionWindow(
  note: Pick<WobbleNote, "onset" | "duration">,
  restAfter: number,
): Window {
  const window = steadyWindow(note);
  if (restAfter >= MIN_REST_FOR_RELEASE) window.end = note.onset + note.duration;
  return window;
}

export interface WobbleStats {
  /**
   * Peak-to-peak of the oscillating part (pitch minus its moving average),
   * in cents. This is the residual vibrato; slow glides and transitions are
   * removed by the moving average.
   */
  wobbleCents: number;
  /** Peak-to-peak of the slow part (the moving average) against the note, in cents. */
  driftCents: number;
  /** Mean deviation from the note pitch (positive = sharp), in cents. */
  meanCents: number;
  /** Zero crossings of the oscillating part (about 2 per vibrato cycle). */
  crossings: number;
  /** Time (blicks) where the oscillation first reaches half its peak amplitude. */
  wobbleStart: number;
  samples: number;
}

/**
 * Deviation statistics of the samples inside `window` against `targetPitch`.
 * `smoothBlick` is the moving-average length separating vibrato-rate
 * oscillation from slow movement (about one vibrato period, ~0.2 s).
 */
export function wobbleStats(
  samples: PitchSamples,
  window: Window,
  targetPitch: number,
  smoothBlick: number,
): WobbleStats | undefined {
  const times: number[] = [];
  const cents: number[] = [];
  samples.values.forEach((value, i) => {
    const t = samples.startBlick + i * samples.intervalBlick;
    if (value === null || t < window.start || t > window.end) return;
    times.push(t);
    cents.push((value - targetPitch) * 100);
  });
  if (cents.length < 3) return undefined;

  const half = smoothBlick / 2;
  const trend = times.map((t) => {
    let sum = 0;
    let count = 0;
    times.forEach((u, j) => {
      if (Math.abs(u - t) <= half) {
        sum += cents[j]!;
        count++;
      }
    });
    return sum / count;
  });
  const osc = cents.map((c, i) => c - trend[i]!);

  let crossings = 0;
  let prevSign = 0;
  for (const o of osc) {
    const sign = Math.sign(o);
    if (sign !== 0) {
      if (prevSign !== 0 && sign !== prevSign) crossings++;
      prevSign = sign;
    }
  }
  const amplitude = Math.max(...osc.map(Math.abs));
  const firstBig = osc.findIndex((o) => Math.abs(o) >= amplitude / 2);
  return {
    wobbleCents: Math.max(...osc) - Math.min(...osc),
    driftCents: Math.max(...trend) - Math.min(...trend),
    meanCents: cents.reduce((a, b) => a + b, 0) / cents.length,
    crossings,
    wobbleStart: times[Math.max(0, firstBig)]!,
    samples: cents.length,
  };
}

/** Points of a flat pitch curve over `window` at `pitch`, spaced `step` apart. */
export function flatCurvePoints(
  window: Window,
  pitch: number,
  step = QUARTER / 16,
): Array<[number, number]> {
  const start = Math.round(window.start);
  const end = Math.round(window.end);
  if (end <= start) return [];
  const points: Array<[number, number]> = [];
  for (let t = start; t < end; t += step) {
    points.push([Math.round(t), pitch]);
  }
  points.push([end, pitch]);
  return points;
}

export interface FlattenOptions {
  /** Curve start after the note onset; default: just before the detected wobble. */
  startOffset?: number;
  /** Detected wobble onset (absolute blicks), if any. */
  wobbleStart?: number;
  /** Moving-average length used for detection (lead-in before the wobble). */
  smoothBlick: number;
  /** Free time after the note until the next sung note (Infinity if none). */
  restAfter: number;
  /** Release tail length past the note end (default a sixteenth note). */
  releaseLength?: number;
  /** How far the release tail falls, in cents (default 35). */
  releaseFallCents?: number;
}

export interface FlattenPlan {
  points: Array<[number, number]>;
  start: number;
  /** Where the flat part ends (the release fall starts here). */
  holdEnd: number;
  end: number;
  release: boolean;
}

/**
 * The curve a user draws with the pen tool to kill residual vibrato: flat at
 * the note pitch from just before the wobble starts, held to just before the
 * note end, then — when a rest follows — a short eased fall past the note end
 * instead of an abrupt stop. Before a following note the curve stops short
 * so SV keeps its own transition.
 */
export function planFlattenCurve(
  note: Pick<WobbleNote, "onset" | "duration" | "pitch">,
  options: FlattenOptions,
): FlattenPlan {
  const noteEnd = note.onset + note.duration;
  const detect = detectionWindow(note, options.restAfter);
  let start: number;
  if (options.startOffset !== undefined) {
    start = note.onset + options.startOffset;
  } else if (options.wobbleStart !== undefined) {
    start = Math.max(detect.start, options.wobbleStart - options.smoothBlick / 2);
  } else {
    start = detect.start;
  }

  const release = options.restAfter >= MIN_REST_FOR_RELEASE;
  let holdEnd: number;
  let end: number;
  if (release) {
    holdEnd = noteEnd - QUARTER / 10;
    const room = options.restAfter - QUARTER / 8;
    end = noteEnd + Math.max(0, Math.min(options.releaseLength ?? QUARTER / 4, room));
  } else {
    holdEnd = noteEnd - QUARTER / 8;
    end = holdEnd;
  }
  start = Math.round(start);
  holdEnd = Math.round(Math.max(start, holdEnd));
  end = Math.round(Math.max(holdEnd, end));

  const points = flatCurvePoints({ start, end: holdEnd }, note.pitch);
  if (release && end > holdEnd) {
    const fall = (options.releaseFallCents ?? 35) / 100;
    const step = QUARTER / 32;
    if (points.length === 0) points.push([holdEnd, note.pitch]);
    for (let t = holdEnd + step; t < end; t += step) {
      const x = (t - holdEnd) / (end - holdEnd);
      points.push([Math.round(t), note.pitch - (fall * (1 - Math.cos(Math.PI * x))) / 2]);
    }
    points.push([end, note.pitch - fall]);
  }
  return { points, start, holdEnd, end, release };
}
