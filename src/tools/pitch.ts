/**
 * Pitch tools: flatten residual vibrato on notes the user names with pen-tool
 * pitch curves (PitchControlCurve), plus raw access to pitch controls so
 * hand-drawn curves can be inspected and copied. There is deliberately no
 * auto-detection tool: targets are chosen by ear, per request.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../bridge.js";
import {
  detectionWindow,
  planFlattenCurve,
  wobbleStats,
  type PitchSamples,
  type WobbleNote,
} from "../pitchWobble.js";
import {
  QUARTER,
  blickToMusical,
  formatPitch,
  musicalToBlick,
  noteValueToBlick,
  type TimeSignature,
} from "../time.js";
import { fail, fetchTimeSignatures, groupSchema, ok, trackSchema } from "./common.js";

const SAMPLE_INTERVAL = QUARTER / 32;
const MAX_FRAMES_PER_REQUEST = 20_000;

const noteValueSchema = z.union([z.string(), z.number()]);

interface BridgePitchControl {
  index: number;
  type: "curve" | "point";
  position: number;
  pitch: number;
  points?: Array<[number, number]>;
}

interface PitchControlsResult {
  group: number;
  groupName: string;
  totalControls: number;
  controls: BridgePitchControl[];
}

interface NotesResult {
  group: number;
  groupName: string;
  totalNotes: number;
  notes: Array<WobbleNote & { phonemes: string }>;
}

function measureRange(
  signatures: TimeSignature[],
  fromMeasure?: number,
  toMeasure?: number,
): { startBlick?: number; endBlick?: number } {
  return {
    ...(fromMeasure !== undefined && {
      startBlick: musicalToBlick({ measure: fromMeasure, beat: 1 }, signatures),
    }),
    ...(toMeasure !== undefined && {
      endBlick: musicalToBlick({ measure: toMeasure + 1, beat: 1 }, signatures),
    }),
  };
}

/** Sample computed pitch over [start, end), splitting into bridge-sized chunks. */
async function sampleComputedPitch(
  bridge: BridgeClient,
  base: Record<string, unknown>,
  start: number,
  end: number,
): Promise<{ samples: PitchSamples; pitchOffset: number; complete: boolean }> {
  const total = Math.max(1, Math.ceil((end - start) / SAMPLE_INTERVAL));
  const values: Array<number | null> = [];
  let pitchOffset = 0;
  let complete = true;
  for (let done = 0; done < total; done += MAX_FRAMES_PER_REQUEST) {
    const numFrames = Math.min(MAX_FRAMES_PER_REQUEST, total - done);
    const chunk = (await bridge.request("get_computed_pitch", {
      ...base,
      startBlick: start + done * SAMPLE_INTERVAL,
      intervalBlick: SAMPLE_INTERVAL,
      numFrames,
    })) as { pitchOffset: number; complete: boolean; values: Array<number | false> };
    pitchOffset = chunk.pitchOffset;
    if (!chunk.complete) complete = false;
    for (let i = 0; i < numFrames; i++) {
      const v = chunk.values[i];
      // SV reports 0 (not null) where there is no voice, e.g. in rests.
      values.push(typeof v === "number" && v > 0 ? v : null);
    }
  }
  return { samples: { startBlick: start, intervalBlick: SAMPLE_INTERVAL, values }, pitchOffset, complete };
}

function overlapping(controls: BridgePitchControl[], start: number, end: number): BridgePitchControl[] {
  return controls.filter((c) => {
    if (c.type !== "curve" || !c.points || c.points.length === 0) return false;
    const first = c.points[0]![0];
    const last = c.points[c.points.length - 1]![0];
    return last >= start && first <= end;
  });
}

function summarizeControl(control: BridgePitchControl, signatures: TimeSignature[], includePoints: boolean) {
  if (control.type === "point") {
    return {
      index: control.index,
      type: "point",
      position: blickToMusical(control.position, signatures).display,
      positionBlick: control.position,
      pitch: control.pitch,
    };
  }
  const points = control.points ?? [];
  const pitches = points.map((p) => p[1]);
  const first = points[0]?.[0] ?? control.position;
  const last = points[points.length - 1]?.[0] ?? control.position;
  return {
    index: control.index,
    type: "curve",
    start: blickToMusical(first, signatures).display,
    end: blickToMusical(last, signatures).display,
    startBlick: first,
    endBlick: last,
    pointCount: points.length,
    pitchRange:
      pitches.length > 0
        ? `${formatPitch(Math.round(Math.min(...pitches)))}..${formatPitch(Math.round(Math.max(...pitches)))}`
        : "",
    minPitch: pitches.length > 0 ? Math.min(...pitches) : undefined,
    maxPitch: pitches.length > 0 ? Math.max(...pitches) : undefined,
    ...(includePoints && { points: points.map(([blick, pitch]) => ({ blick, pitch })) }),
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

interface TempoMark {
  positionBlick: number;
  bpm: number;
}

/** ~0.2 s in blicks at `blick`: one cycle of a typical 5 Hz vibrato. */
function smoothBlickAt(tempo: TempoMark[], blick: number): number {
  let bpm = tempo[0]?.bpm ?? 120;
  for (const mark of tempo) if (mark.positionBlick <= blick) bpm = mark.bpm;
  return (QUARTER * bpm * 0.2) / 60;
}

/** Free time after `note` until the next sung note (breath notes don't count). */
function restAfter(sung: WobbleNote[], note: WobbleNote): number {
  const end = note.onset + note.duration;
  const next = sung.find((n) => n.onset >= end - 1 && n.index !== note.index);
  return next ? next.onset - end : Number.POSITIVE_INFINITY;
}

export function registerPitchTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    "flatten_pitch",
    {
      description:
        "Kill residual vibrato the way it is done by hand with the pen tool: " +
        "draw a pitch curve flat at the written note pitch, starting just " +
        "before the detected wobble (or at `startOffset` after the note onset), " +
        "held to just before the note end. When a rest follows (breath notes " +
        "count as rest), the curve continues past the note end with a short " +
        "eased fall (`releaseLength`, default a sixteenth; `releaseFallCents`, " +
        "default 35) instead of stopping abruptly; before a following note it " +
        "stops short so SV keeps its own transition. Notes that already have a " +
        "curve over that span are skipped unless `replace` is true, in which " +
        "case the overlapping curves are deleted first (a separate undo step); " +
        "the wobble is then measured with the old curve still applied, so pass " +
        "`startOffset` when replacing.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        notes: z
          .array(
            z.object({
              index: z.number().int().min(1).describe("Note index (see get_notes)"),
              startOffset: noteValueSchema
                .optional()
                .describe('Curve start after the note onset, e.g. "1/8"; default: before the wobble'),
            }),
          )
          .min(1)
          .describe("Notes to flatten"),
        releaseLength: noteValueSchema
          .optional()
          .describe('Release tail past the note end when a rest follows (default "1/16")'),
        releaseFallCents: z
          .number()
          .optional()
          .describe("How far the release tail falls, in cents (default 35; 0 keeps it flat)"),
        replace: z
          .boolean()
          .optional()
          .describe("Delete existing curves overlapping the target spans (default false)"),
      },
    },
    async ({ track, group, notes, releaseLength, releaseFallCents, replace }) => {
      try {
        const axis = (await bridge.request("get_time_axis")) as {
          timeSignatures: TimeSignature[];
          tempo: TempoMark[];
        };
        const signatures = axis.timeSignatures;
        const base = { track, ...(group !== undefined && { group }) };
        const all = (await bridge.request("get_notes", base)) as NotesResult;
        const sung = all.notes.filter((n) => n.phonemes !== "br");
        const existing = (await bridge.request("get_pitch_controls", base)) as PitchControlsResult;

        const curves: Array<{ points: Array<[number, number]> }> = [];
        const toDelete = new Set<number>();
        const flattened = [];
        const skipped = [];
        for (const target of notes) {
          const note = all.notes.find((n) => n.index === target.index);
          if (!note) {
            throw new Error(`Note ${target.index} does not exist (group has ${all.totalNotes} note(s))`);
          }
          const rest = restAfter(sung, note);
          const smooth = smoothBlickAt(axis.tempo, note.onset);
          let wobbleStart: number | undefined;
          if (target.startOffset === undefined) {
            const { samples, pitchOffset } = await sampleComputedPitch(
              bridge,
              base,
              note.onset,
              note.onset + note.duration,
            );
            const stats = wobbleStats(samples, detectionWindow(note, rest), note.pitch + pitchOffset, smooth);
            wobbleStart = stats?.wobbleStart;
          }
          const plan = planFlattenCurve(note, {
            ...(target.startOffset !== undefined && { startOffset: noteValueToBlick(target.startOffset) }),
            ...(wobbleStart !== undefined && { wobbleStart }),
            smoothBlick: smooth,
            restAfter: rest,
            ...(releaseLength !== undefined && { releaseLength: noteValueToBlick(releaseLength) }),
            ...(releaseFallCents !== undefined && { releaseFallCents }),
          });
          if (plan.points.length < 2) {
            skipped.push({ index: note.index, reason: "note too short for a curve" });
            continue;
          }
          const clashes = overlapping(existing.controls, plan.start, plan.end);
          if (clashes.length > 0 && !replace) {
            skipped.push({
              index: note.index,
              reason: `already has pitch curve(s) ${clashes.map((c) => c.index).join(", ")}; pass replace: true`,
            });
            continue;
          }
          clashes.forEach((c) => toDelete.add(c.index));
          curves.push({ points: plan.points });
          flattened.push({
            index: note.index,
            lyrics: note.lyrics,
            pitch: formatPitch(note.pitch),
            from: blickToMusical(plan.start, signatures).display,
            holdTo: blickToMusical(plan.holdEnd, signatures).display,
            to: blickToMusical(plan.end, signatures).display,
            release: plan.release,
          });
        }

        let deletedCount = 0;
        if (toDelete.size > 0) {
          const deleted = (await bridge.request("delete_pitch_controls", {
            ...base,
            indexes: [...toDelete],
          })) as { deletedCount: number };
          deletedCount = deleted.deletedCount;
        }
        let totalControls = existing.totalControls - deletedCount;
        if (curves.length > 0) {
          const added = (await bridge.request("add_pitch_curves", { ...base, curves })) as PitchControlsResult;
          totalControls = added.totalControls;
        }
        return ok({
          group: all.group,
          flattened,
          skipped,
          deletedCurves: deletedCount,
          totalControls,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_pitch_controls",
    {
      description:
        "List the pitch controls of a group: pen-tool pitch curves (with their " +
        "time span and pitch range) and pitch anchor points. Indices are sorted " +
        "by position and shift when controls are added or deleted. Set " +
        "`includePoints` to get every curve point as {blick, pitch} (absolute " +
        "blicks, MIDI pitch) — e.g. to copy a hand-drawn curve to another " +
        "occurrence of a phrase with add_pitch_curves.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        fromMeasure: z.number().int().min(1).optional().describe("First measure (1-based, inclusive)"),
        toMeasure: z.number().int().min(1).optional().describe("Last measure (1-based, inclusive)"),
        includePoints: z.boolean().optional().describe("Include curve points (default false)"),
      },
    },
    async ({ track, group, fromMeasure, toMeasure, includePoints }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        const result = (await bridge.request("get_pitch_controls", {
          track,
          ...(group !== undefined && { group }),
          ...measureRange(signatures, fromMeasure, toMeasure),
        })) as PitchControlsResult;
        return ok({
          group: result.group,
          groupName: result.groupName,
          totalControls: result.totalControls,
          controls: result.controls.map((c) => summarizeControl(c, signatures, includePoints ?? false)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "add_pitch_curves",
    {
      description:
        "Add pen-tool pitch curves that override the generated pitch. Each " +
        "curve is a list of {blick, pitch} points in ascending time (absolute " +
        "blicks as in get_notes' onsetBlick; pitch as a fractional MIDI number " +
        "in the note pitch space). To copy a curve to a repeat of the phrase, " +
        "shift every blick by the distance between the two occurrences. One " +
        "undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        curves: z
          .array(
            z.object({
              points: z
                .array(z.object({ blick: z.number(), pitch: z.number() }))
                .min(2)
                .describe("Curve points in ascending time"),
            }),
          )
          .min(1)
          .describe("Curves to add"),
      },
    },
    async ({ track, group, curves }) => {
      try {
        const signatures = await fetchTimeSignatures(bridge);
        const result = (await bridge.request("add_pitch_curves", {
          track,
          ...(group !== undefined && { group }),
          curves: curves.map((c) => ({ points: c.points.map((p) => [p.blick, p.pitch]) })),
        })) as PitchControlsResult & { addedCount: number };
        return ok({
          group: result.group,
          addedCount: result.addedCount,
          totalControls: result.totalControls,
          controlsInRange: result.controls.map((c) => summarizeControl(c, signatures, false)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "delete_pitch_controls",
    {
      description:
        "Delete pitch controls (curves or anchor points) by index from " +
        "get_pitch_controls. Remaining controls are renumbered. One undo step.",
      inputSchema: {
        track: trackSchema,
        group: groupSchema,
        indexes: z
          .array(z.number().int().min(1))
          .min(1)
          .describe("Pitch control indices to delete (see get_pitch_controls)"),
      },
    },
    async ({ track, group, indexes }) => {
      try {
        const result = await bridge.request("delete_pitch_controls", {
          track,
          ...(group !== undefined && { group }),
          indexes,
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
