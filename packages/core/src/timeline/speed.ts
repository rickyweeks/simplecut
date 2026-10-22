import type { Clip, Frame, Id, Timeline } from '../types';
import { setClips, shiftClips } from './primitives';
import { clipEnd, clipSpeed, isTrackLocked, linkedClips, sourceSpan } from './query';
import { rippleOtherTracks } from './trim';

/**
 * Clip speed. A clip at speed s shows s source frames per timeline frame; everything that
 * maps timeline time to source time goes through these helpers.
 */

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;
export const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;

/**
 * Changes the speed of clips (and their linked partners). The clip keeps the same source
 * material, so its length changes; later clips on its track move to follow, and other
 * tracks follow when it is safe (same rule as a ripple trim).
 */
export function setClipSpeed(tl: Timeline, clipIds: Id[], speed: number): Timeline {
  const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  const all = new Map<Id, Clip>();
  for (const id of clipIds) {
    const c = tl.clips[id];
    if (!c || c.text || isTrackLocked(tl, c.trackId)) continue;
    all.set(c.id, c);
    for (const p of linkedClips(tl, c)) if (!isTrackLocked(tl, p.trackId)) all.set(p.id, p);
  }
  // Process from the end of the timeline so earlier shifts don't move later targets twice.
  const clips = [...all.values()].sort((a, b) => b.start - a.start);
  let out = tl;
  const involved = new Set<Id>();
  let lastEnd = 0;
  let lastShift = 0;
  for (const original of clips) {
    const c = out.clips[original.id]!;
    if (Math.abs(clipSpeed(c) - s) < 1e-9) continue;
    const duration = Math.max(1, Math.round(sourceSpan(c, c.duration) / s));
    const shift = duration - c.duration;
    const oldEnd = clipEnd(c);
    out = shiftClips(out, [c.trackId], oldEnd, shift);
    const next: Clip = { ...c, duration, speed: s };
    if (s === 1) delete next.speed;
    out = setClips(out, [next]);
    involved.add(c.trackId);
    lastEnd = oldEnd;
    lastShift = shift;
  }
  // Single clip (with its linked partners): other tracks follow like a ripple trim.
  return involved.size && clips.length && new Set(clips.map((c) => c.start)).size === 1 ? rippleOtherTracks(out, involved, lastEnd, lastShift) : out;
}
