import { defaultIds, type IdGen } from '../ids';
import type { Clip, Frame, Id, Timeline, TrackKind } from '../types';
import { IdRemap, clearRange, setClips, shiftClips, splitAt, withIds } from './primitives';
import { clipEnd, getTrack, isTrackLocked, trackIndex, tracksOfKind, unlockedTrackIds } from './query';

export interface MoveOptions {
  /** Alt+drag: leave the originals and move copies. */
  duplicate?: boolean;
  /** Ctrl+drag: push material at the drop point later instead of overwriting it. */
  insert?: boolean;
}

/**
 * Clamps a vertical move so every clip stays on an existing track of its kind.
 * Linked video and audio move "away from the middle" together: V1→V2 pairs with A1→A2.
 */
export function clampTrackDelta(tl: Timeline, clips: Clip[], deltaTrack: number): number {
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  for (const kind of ['video', 'audio'] as TrackKind[]) {
    const ofKind = clips.filter((c) => c.kind === kind);
    if (!ofKind.length) continue;
    const idx = ofKind.map((c) => trackIndex(tl, c.trackId));
    const n = tracksOfKind(tl, kind).length;
    lo = Math.max(lo, -Math.min(...idx));
    hi = Math.min(hi, n - 1 - Math.max(...idx));
  }
  if (lo > hi) return 0;
  return Math.max(lo, Math.min(hi, deltaTrack));
}

/**
 * Places clip copies or moved clips at new positions with overwrite (default) or insert
 * semantics. `clips` already carry their final start/trackId.
 */
function placeAt(tl: Timeline, clips: Clip[], insert: boolean, ids: IdGen): Timeline {
  if (!clips.length) return tl;
  let out = tl;
  if (insert) {
    const s0 = Math.min(...clips.map((c) => c.start));
    const span = Math.max(...clips.map(clipEnd)) - s0;
    const unlocked = unlockedTrackIds(out);
    out = splitAt(out, unlocked, s0, ids);
    out = shiftClips(out, unlocked, s0, span);
  } else {
    const links = new IdRemap(ids);
    for (const c of clips) out = clearRange(out, [c.trackId], c.start, clipEnd(c), ids, links);
  }
  return setClips(out, clips);
}

/** Moves (or duplicates) clips by a frame delta and a track delta. Overwrites by default, like Premiere. */
export function moveClips(
  tl: Timeline,
  clipIds: Iterable<Id>,
  deltaFrames: Frame,
  deltaTrack: number,
  opts: MoveOptions = {},
  ids: IdGen = defaultIds,
): Timeline {
  const clips = [...new Set(clipIds)].map((id) => tl.clips[id]).filter((c): c is Clip => !!c);
  if (!clips.length || clips.some((c) => isTrackLocked(tl, c.trackId))) return tl;

  const minStart = Math.min(...clips.map((c) => c.start));
  const d = Math.max(Math.round(deltaFrames), -minStart);
  const dt = clampTrackDelta(tl, clips, deltaTrack);
  if (d === 0 && dt === 0 && !opts.duplicate) return tl;

  const targets = new Map<Id, Id>();
  for (const c of clips) {
    const target = tracksOfKind(tl, c.kind)[trackIndex(tl, c.trackId) + dt];
    if (!target || target.locked) return tl;
    targets.set(c.id, target.id);
  }

  const links = new IdRemap(ids);
  const groups = new IdRemap(ids);
  const moved = clips.map((c) => {
    const next = { ...c, start: c.start + d, trackId: targets.get(c.id)! };
    return opts.duplicate ? withIds({ ...next, id: ids() }, links.get(c.linkId), groups.get(c.groupId)) : next;
  });

  const base = opts.duplicate ? tl : setClips(tl, [], clips.map((c) => c.id));
  return placeAt(base, moved, !!opts.insert, ids);
}

/**
 * Ctrl+V: pastes copied clips so the earliest one starts at `at`, on the same tracks
 * they were copied from (skipping tracks that are gone or locked). Overwrites.
 */
export function pasteClips(tl: Timeline, copied: Clip[], at: Frame, ids: IdGen = defaultIds): Timeline {
  const usable = copied.filter((c) => {
    const t = getTrack(tl, c.trackId);
    return t && !t.locked && t.kind === c.kind;
  });
  if (!usable.length) return tl;
  const offset = at - Math.min(...usable.map((c) => c.start));
  const links = new IdRemap(ids);
  const groups = new IdRemap(ids);
  const placed = usable.map((c) => withIds({ ...c, id: ids(), start: c.start + offset }, links.get(c.linkId), groups.get(c.groupId)));
  return placeAt(tl, placed, false, ids);
}
