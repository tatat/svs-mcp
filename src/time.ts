/**
 * Conversion between musical time and SV's internal unit (blicks).
 *
 * Public interface (tool inputs/outputs) uses 1-based measures and beats, as
 * in sheet music. The SV scripting API uses 0-based measure numbers
 * (verified against SV Studio 2 Pro 2.2.1), so conversion happens here.
 *
 * Durations and offsets are "note values": strings like "1/4", "1/8",
 * "1/8." (dotted), "1/12" (triplet eighth), "3/16", or a plain number
 * meaning that many quarter notes.
 */

/** Blicks per quarter note (same as SV.QUARTER). */
export const QUARTER = 705_600_000;

/** Blicks per whole note. */
export const WHOLE = 4 * QUARTER;

/** A time signature change, as reported by the bridge (0-based measure). */
export interface TimeSignature {
  measure: number;
  positionBlick: number;
  numerator: number;
  denominator: number;
}

/** A position in the public 1-based measure/beat form. */
export interface MusicalPosition {
  measure: number;
  beat: number;
  /** Note-value offset from the start of the beat. */
  offset?: string | number | undefined;
}

export class TimeError extends Error {}

/** Parse a note value into blicks. */
export function noteValueToBlick(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TimeError(`Invalid note value: ${value}`);
    }
    return Math.round(value * QUARTER);
  }

  const match = /^(\d+)\/(\d+)(\.{0,2})$/.exec(value.trim());
  if (!match) {
    throw new TimeError(
      `Invalid note value "${value}". Use forms like "1/4", "1/8.", "3/16", "1/12", ` +
        `or a number of quarter notes.`,
    );
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const dots = match[3]!.length;
  if (numerator === 0 || denominator === 0) {
    throw new TimeError(`Invalid note value "${value}".`);
  }
  const base = (WHOLE * numerator) / denominator;
  const dotted = base * (dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75);
  return Math.round(dotted);
}

/** Format blicks as a note value ("1/8", "1/8.", or quarter count like "1.33q"). */
export function blickToNoteValue(blick: number): string {
  for (const denominator of [1, 2, 4, 8, 16, 32, 64, 128, 3, 6, 12, 24, 48, 96]) {
    const unit = WHOLE / denominator;
    if (blick % unit === 0) {
      const numerator = blick / unit;
      return `${numerator}/${denominator}`;
    }
    // Dotted values: blick = 1.5 * (WHOLE * n / denominator)
    const dottedUnit = unit * 1.5;
    if (blick % dottedUnit === 0 && blick / dottedUnit === 1) {
      return `1/${denominator}.`;
    }
  }
  return `${(blick / QUARTER).toFixed(3).replace(/\.?0+$/, "")}q`;
}

function sortedSignatures(signatures: TimeSignature[]): TimeSignature[] {
  if (signatures.length === 0) {
    // SV always reports at least the initial mark; be defensive anyway.
    return [{ measure: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  }
  return [...signatures].sort((a, b) => a.measure - b.measure);
}

const measureLength = (sig: TimeSignature): number => (WHOLE * sig.numerator) / sig.denominator;
const beatLength = (sig: TimeSignature): number => WHOLE / sig.denominator;

/** Convert a public (1-based) musical position to blicks. */
export function musicalToBlick(position: MusicalPosition, signatures: TimeSignature[]): number {
  const measure0 = position.measure - 1;
  if (!Number.isInteger(measure0) || measure0 < 0) {
    throw new TimeError(`Invalid measure ${position.measure}; measures are numbered from 1.`);
  }
  if (!Number.isInteger(position.beat) || position.beat < 1) {
    throw new TimeError(`Invalid beat ${position.beat}; beats are numbered from 1.`);
  }

  const sigs = sortedSignatures(signatures);
  let governing = sigs[0]!;
  for (const sig of sigs) {
    if (sig.measure <= measure0) governing = sig;
  }

  if (position.beat > governing.numerator) {
    throw new TimeError(
      `Beat ${position.beat} does not exist in measure ${position.measure} ` +
        `(time signature is ${governing.numerator}/${governing.denominator}).`,
    );
  }

  const offsetBlick = position.offset === undefined ? 0 : noteValueToBlick(position.offset);
  return (
    governing.positionBlick +
    (measure0 - governing.measure) * measureLength(governing) +
    (position.beat - 1) * beatLength(governing) +
    offsetBlick
  );
}

export interface MusicalPositionOut {
  measure: number;
  beat: number;
  offsetBlick: number;
  /** Compact display such as "5.2" or "5.2+1/16". */
  display: string;
}

/** Convert blicks to the public (1-based) musical position. */
export function blickToMusical(blick: number, signatures: TimeSignature[]): MusicalPositionOut {
  const sigs = sortedSignatures(signatures);
  let governing = sigs[0]!;
  for (const sig of sigs) {
    if (sig.positionBlick <= blick) governing = sig;
  }

  const fromMark = blick - governing.positionBlick;
  const mLen = measureLength(governing);
  const bLen = beatLength(governing);
  const measuresFromMark = Math.floor(fromMark / mLen);
  const withinMeasure = fromMark - measuresFromMark * mLen;
  const beat0 = Math.floor(withinMeasure / bLen);
  const offsetBlick = withinMeasure - beat0 * bLen;

  const measure = governing.measure + measuresFromMark + 1;
  const beat = beat0 + 1;
  const display =
    offsetBlick === 0
      ? `${measure}.${beat}`
      : `${measure}.${beat}+${blickToNoteValue(offsetBlick)}`;
  return { measure, beat, offsetBlick, display };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const PITCH_OFFSETS: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** Parse a pitch given as a note name ("C4", "F#3", "Bb5") or MIDI number. */
export function parsePitch(pitch: string | number): number {
  if (typeof pitch === "number") {
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
      throw new TimeError(`Invalid MIDI pitch ${pitch}; expected an integer 0-127.`);
    }
    return pitch;
  }
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(pitch.trim());
  if (!match) {
    throw new TimeError(`Invalid pitch "${pitch}". Use a note name like "C4" or a MIDI number.`);
  }
  const base = PITCH_OFFSETS[match[1]!.toUpperCase()]!;
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const octave = Number(match[3]);
  const midi = (octave + 1) * 12 + base + accidental;
  if (midi < 0 || midi > 127) {
    throw new TimeError(`Pitch "${pitch}" is out of MIDI range 0-127.`);
  }
  return midi;
}

/** Format a MIDI number as a note name with sharps (60 -> "C4"). */
export function formatPitch(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[midi % 12]}${octave}`;
}
