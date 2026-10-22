import type { IdGen } from '../ids';
import type { Clip, Frame, Id, Timeline } from '../types';
import { clipAt, clipEnd, clipsInRange, clipsOnTrack, isTrackLocked } from './query';

/**
 * During one operation, right-hand pieces of split clips get fresh link/group ids so the
 * left pieces stay linked to each other and the right pieces stay linked to each other.
 */
export class IdRemap {
  private map = new Map<Id, Id>();
  constructor(private ids: IdGen) {}
  get(old: Id | undefined): Id | undefined {
    if (!old) return undefined;
    let next = this.map.get(old);
    if (!next) {
      next = this.ids();
      this.map.set(old, next);
    }
    return next;
  }
}

/**
 * Returns a copy of the clip with its link/group ids set or removed (never left as
 * undefined keys). Both are required: pass the clip's own value to keep it.
 */
export function withIds(clip: Clip, linkId: Id | undefined, groupId: Id | undefined): Clip {
  const { linkId: _l, groupId: _g, ...rest } = clip;
  const out: Clip = { ...rest };
  if (linkId) out.linkId = linkId;
  if (groupId) out.groupId = groupId;
  return out;
}

/**
 * Removes what belongs to one edge of a clip (its transition and audio fade). Used when an
 * edit creates a brand-new edge, e.g. the inner edges of a razor cut.
 */
export function stripEdge(clip: Clip, edge: 'in' | 'out'): Clip {
  if (edge === 'in') {
    const { transitionIn: _t, fadeIn: _f, ...rest } = clip;
    return rest;
  }
  const { transitionOut: _t, fadeOut: _f, ...rest } = clip;
  return rest;
}

export function setClips(tl: Timeline, updates: Clip[], removeIds: Iterable<Id> = []): Timeline {
  const clips = { ...tl.clips };
  for (const id of removeIds) delete clips[id];
  for (const c of updates) clips[c.id] = c;
  return { ...tl, clips };
}

/** Splits one clip at a frame strictly inside it. The left piece keeps the id. */
export function splitClip(clip: Clip, frame: Frame, ids: IdGen, links: IdRemap): [Clip, Clip] | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null;
  const leftDuration = frame - clip.start;
  const left = stripEdge({ ...clip, duration: leftDuration }, 'out');
  const right = stripEdge(
    withIds(
      { ...clip, id: ids(), start: frame, duration: clip.duration - leftDuration, sourceIn: clip.sourceIn + leftDuration },
      links.get(clip.linkId),
      clip.groupId,
    ),
    'in',
  );
  return [left, right];
}

/** Splits every clip that crosses `frame` on the given (unlocked) tracks. */
export function splitAt(tl: Timeline, trackIds: Id[], frame: Frame, ids: IdGen, links = new IdRemap(ids)): Timeline {
  const updates: Clip[] = [];
  for (const trackId of trackIds) {
    if (isTrackLocked(tl, trackId)) continue;
    const c = clipAt(tl, trackId, frame);
    if (!c) continue;
    const parts = splitClip(c, frame, ids, links);
    if (parts) updates.push(...parts);
  }
  return updates.length ? setClips(tl, updates) : tl;
}

/**
 * Removes everything inside [start, end) on the given (unlocked) tracks, trimming or
 * splitting clips that stick out. Nothing moves.
 */
export function clearRange(
  tl: Timeline,
  trackIds: Id[],
  start: Frame,
  end: Frame,
  ids: IdGen,
  links = new IdRemap(ids),
): Timeline {
  if (end <= start) return tl;
  const updates: Clip[] = [];
  const removed: Id[] = [];
  for (const trackId of trackIds) {
    if (isTrackLocked(tl, trackId)) continue;
    for (const c of clipsInRange(tl, trackId, start, end)) {
      const cEnd = clipEnd(c);
      if (c.start >= start && cEnd <= end) {
        removed.push(c.id);
      } else if (c.start < start && cEnd > end) {
        updates.push(stripEdge({ ...c, duration: start - c.start }, 'out'));
        updates.push(
          stripEdge(
            withIds(
              { ...c, id: ids(), start: end, duration: cEnd - end, sourceIn: c.sourceIn + (end - c.start) },
              links.get(c.linkId),
              c.groupId,
            ),
            'in',
          ),
        );
      } else if (c.start < start) {
        updates.push(stripEdge({ ...c, duration: start - c.start }, 'out'));
      } else {
        updates.push(stripEdge({ ...c, start: end, duration: cEnd - end, sourceIn: c.sourceIn + (end - c.start) }, 'in'));
      }
    }
  }
  return updates.length || removed.length ? setClips(tl, updates, removed) : tl;
}

/** Moves every clip that starts at or after `from` by `delta` frames, on the given (unlocked) tracks. */
export function shiftClips(tl: Timeline, trackIds: Id[], from: Frame, delta: Frame): Timeline {
  if (delta === 0) return tl;
  const updates: Clip[] = [];
  for (const trackId of trackIds) {
    if (isTrackLocked(tl, trackId)) continue;
    for (const c of clipsOnTrack(tl, trackId)) if (c.start >= from) updates.push({ ...c, start: c.start + delta });
  }
  return updates.length ? setClips(tl, updates) : tl;
}

/** Removes clips, skipping any on locked tracks. */
export function removeClips(tl: Timeline, clipIds: Iterable<Id>): Timeline {
  const removable = [...clipIds].filter((id) => {
    const c = tl.clips[id];
    return c && !isTrackLocked(tl, c.trackId);
  });
  return removable.length ? setClips(tl, [], removable) : tl;
}
