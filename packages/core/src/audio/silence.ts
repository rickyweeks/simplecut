import type { IdGen } from '../ids';
import { defaultIds } from '../ids';
import { rippleDeleteRange } from '../timeline/edit';
import { clipEnd, clipSpeed, linkedClips, mergeRanges } from '../timeline/query';
import type { Clip, Frame, Id, Range, Timeline } from '../types';

/**
 * Remove silences (auto jump cut) for talking-head videos: FFmpeg's silencedetect finds the
 * pauses in each clip's sound, they're shown on the timeline for review, and the ones you
 * keep selected are ripple-deleted in one go (the music bed is never chopped).
 */

export interface SilenceSettings {
  /** Quieter than this counts as silence (dBFS). */
  thresholdDb: number;
  /** Only pauses at least this long are removed (seconds). */
  minSec: number;
  /** Breathing room kept on each side of a cut (seconds). */
  paddingSec: number;
}

export const DEFAULT_SILENCE: SilenceSettings = { thresholdDb: -38, minSec: 0.6, paddingSec: 0.12 };

/** Analysis of one clip's audio over the part of the source it uses. */
export function silenceDetectArgs(path: string, startSec: number, durationSec: number, s: SilenceSettings): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
    '-t', durationSec.toFixed(3),
    '-i', path,
    '-vn',
    '-af', `silencedetect=noise=${s.thresholdDb}dB:d=${Math.max(0.05, s.minSec).toFixed(3)}`,
    '-f', 'null',
    '-',
  ];
}

/** Reads silencedetect's log: [start, end) pairs in seconds from the analysed start. */
export function parseSilenceDetect(log: string, totalSec: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') open = t;
    else if (open != null) {
      out.push({ start: open, end: Math.min(totalSec, t) });
      open = null;
    }
  }
  if (open != null && open < totalSec) out.push({ start: open, end: totalSec });
  return out.filter((r) => r.end > r.start);
}

/**
 * Turns pauses found in a clip (seconds from the start of the source it plays) into timeline
 * ranges to remove. Padding keeps a little air around speech; a pause at the very start or
 * end of the clip is trimmed right up to the clip edge.
 */
export function silenceRanges(clip: Pick<Clip, 'start' | 'duration' | 'speed'>, pauses: { start: number; end: number }[], fps: number, s: SilenceSettings): Range[] {
  const speed = clipSpeed(clip);
  const end = clipEnd(clip as Clip);
  const out: Range[] = [];
  for (const p of pauses) {
    const atStart = p.start <= 0.02;
    const a = clip.start + Math.round(((atStart ? 0 : p.start + s.paddingSec) * fps) / speed);
    const rawEnd = clip.start + Math.round((p.end * fps) / speed);
    const atEnd = rawEnd >= end - 1;
    const b = atEnd ? end : clip.start + Math.round(((p.end - s.paddingSec) * fps) / speed);
    const lo = Math.max(clip.start, a);
    const hi = Math.min(end, b);
    if (hi - lo >= Math.max(2, Math.round(0.1 * fps))) out.push({ start: lo, end: hi });
  }
  return out;
}

/** The tracks a silence cut is made on: the analysed clips' tracks and their linked partners'. */
export function silenceTracks(tl: Timeline, clipIds: Id[]): Id[] {
  const tracks = new Set<Id>();
  for (const id of clipIds) {
    const c = tl.clips[id];
    if (!c) continue;
    tracks.add(c.trackId);
    for (const p of linkedClips(tl, c)) tracks.add(p.trackId);
  }
  return [...tracks];
}

/**
 * Removes the ranges from the given tracks and closes the gaps (last to first, so earlier
 * ranges stay valid). Tracks with material across a range (a music bed) stay as they are.
 */
export function removeSilences(tl: Timeline, trackIds: Id[], ranges: Range[], ids: IdGen = defaultIds): Timeline {
  let out = tl;
  for (const r of [...mergeRanges(ranges)].reverse()) out = rippleDeleteRange(out, r.start, r.end, trackIds, ids);
  return out;
}

export const totalFrames = (ranges: Range[]): Frame => ranges.reduce((n, r) => n + r.end - r.start, 0);
