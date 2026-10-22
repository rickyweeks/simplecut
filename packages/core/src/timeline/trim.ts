import { mediaFrameCount } from '../time';
import type { Clip, Frame, Id, MediaInfo, Timeline } from '../types';
import { setClips, shiftClips } from './primitives';
import { clipEnd, clipsOnTrack, isRangeEmpty, isTrackLocked, linkedClips, unlockedTrackIds } from './query';

export type Edge = 'start' | 'end';
export type MediaLookup = Record<Id, Pick<MediaInfo, 'kind' | 'durationSec'> | undefined>;

/** The clip plus linked partners whose same edge sits on the same frame (they trim together). */
export function edgeClips(tl: Timeline, clipId: Id, edge: Edge, withLinked = true): Clip[] {
  const clip = tl.clips[clipId];
  if (!clip) return [];
  if (!withLinked) return [clip];
  const pos = edge === 'start' ? clip.start : clipEnd(clip);
  return [clip, ...linkedClips(tl, clip).filter((p) => (edge === 'start' ? p.start : clipEnd(p)) === pos)];
}

/** How far an edge can move: [min, max] frames. */
export function trimLimits(tl: Timeline, media: MediaLookup, clips: Clip[], edge: Edge, ripple: boolean): { min: Frame; max: Frame } {
  const fps = tl.settings.fps;
  const ids = new Set(clips.map((c) => c.id));
  let min = Number.NEGATIVE_INFINITY;
  let max = Number.POSITIVE_INFINITY;
  for (const c of clips) {
    const m = media[c.mediaId];
    // Offline media: allow shortening but not extending past what we know.
    const total = c.text ? Number.POSITIVE_INFINITY : m ? mediaFrameCount(m, fps) : c.sourceIn + c.duration;
    const others = clipsOnTrack(tl, c.trackId).filter((o) => !ids.has(o.id));
    if (edge === 'start') {
      max = Math.min(max, c.duration - 1);
      min = Math.max(min, -c.sourceIn);
      if (!ripple) {
        min = Math.max(min, -c.start);
        const prevEnd = Math.max(0, ...others.filter((o) => clipEnd(o) <= c.start).map(clipEnd));
        min = Math.max(min, prevEnd - c.start);
      }
    } else {
      min = Math.max(min, -(c.duration - 1));
      max = Math.min(max, total - c.sourceIn - c.duration);
      if (!ripple) {
        const nexts = others.filter((o) => o.start >= clipEnd(c)).map((o) => o.start);
        if (nexts.length) max = Math.min(max, Math.min(...nexts) - clipEnd(c));
      }
    }
  }
  return { min: Math.min(min, 0), max: Math.max(max, 0) };
}

/**
 * On tracks not directly involved in a ripple, follow the edit only if it is safe:
 * closing requires the closed range to be empty there, opening requires that no clip
 * straddles the edit point.
 */
function rippleOtherTracks(tl: Timeline, skipTracks: Set<Id>, at: Frame, shift: Frame): Timeline {
  if (shift === 0) return tl;
  const tracks = unlockedTrackIds(tl).filter((t) => {
    if (skipTracks.has(t)) return false;
    if (shift < 0) return isRangeEmpty(tl, t, at + shift, at);
    return !clipsOnTrack(tl, t).some((c) => c.start < at && clipEnd(c) > at);
  });
  return shiftClips(tl, tracks, at, shift);
}

/**
 * Drags a clip edge by `delta` frames.
 * - Normal trim: the edge moves; neighbours and media length limit it; nothing else moves.
 * - Ripple trim: the clip's other edge stays put and everything after it slides to follow.
 */
export function trimClips(
  tl: Timeline,
  media: MediaLookup,
  clipIds: Id[],
  edge: Edge,
  delta: Frame,
  opts: { ripple?: boolean } = {},
): Timeline {
  const ripple = !!opts.ripple;
  const clips = clipIds.map((id) => tl.clips[id]).filter((c): c is Clip => !!c && !isTrackLocked(tl, c.trackId));
  if (clips.length === 0) return tl;
  const { min, max } = trimLimits(tl, media, clips, edge, ripple);
  const d = Math.max(min, Math.min(max, Math.round(delta)));
  if (d === 0) return tl;

  if (!ripple) {
    return setClips(
      tl,
      clips.map((c) =>
        edge === 'start' ? { ...c, start: c.start + d, sourceIn: c.sourceIn + d, duration: c.duration - d } : { ...c, duration: c.duration + d },
      ),
    );
  }

  // Ripple: start-edge trims keep the clip's start in place; both edges shift what follows.
  const shift = edge === 'start' ? -d : d;
  let out = tl;
  const involved = new Set<Id>();
  for (const c of clips) {
    involved.add(c.trackId);
    const oldEnd = clipEnd(c);
    const updated = edge === 'start' ? { ...c, sourceIn: c.sourceIn + d, duration: c.duration - d } : { ...c, duration: c.duration + d };
    // Shift followers on this track first (the trimmed clip itself starts before oldEnd).
    out = shiftClips(out, [c.trackId], oldEnd, shift);
    out = setClips(out, [updated]);
  }
  return rippleOtherTracks(out, involved, clipEnd(clips[0]!), shift);
}
