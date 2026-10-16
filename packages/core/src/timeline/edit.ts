import { defaultIds, type IdGen } from '../ids';
import { mediaFrameCount } from '../time';
import type { Clip, Frame, Id, MediaItem, Range, Timeline } from '../types';
import { IdRemap, clearRange, removeClips, setClips, shiftClips, splitAt, splitClip } from './primitives';
import {
  audioTracks,
  clipAt,
  clipEnd,
  getTrack,
  isRangeEmpty,
  isTrackLocked,
  linkedClips,
  mergeRanges,
  unlockedTrackIds,
  videoTracks,
} from './query';
import { autoMatchSettings } from './structure';

/** Default length of a still image when no Out mark is set. */
export const DEFAULT_IMAGE_SECONDS = 5;

/** What the source monitor hands to insert/overwrite. Times are in seconds so they survive frame-rate changes. */
export interface SourceSelection {
  mediaId: Id;
  /** Start in seconds into the media. */
  inSec: number;
  /** Exclusive end in seconds. Null = end of media (or DEFAULT_IMAGE_SECONDS for a still). */
  outSec: number | null;
  /** V source toggle: bring in the picture. */
  video: boolean;
  /** A source toggle: bring in the sound. */
  audio: boolean;
}

export interface PlacementTracks {
  videoTrackId: Id | null;
  audioTrackId: Id | null;
}

/** Converts a source selection to timeline frames, clamped to the media length. */
export function sourceFrames(media: MediaItem, sel: SourceSelection, fps: number): { sourceIn: Frame; duration: Frame } | null {
  const total = mediaFrameCount(media, fps);
  const sourceIn = Math.max(0, Math.round(sel.inSec * fps));
  let end: Frame;
  if (sel.outSec != null) end = Math.round(sel.outSec * fps);
  else end = media.kind === 'image' ? sourceIn + DEFAULT_IMAGE_SECONDS * fps : total;
  end = Math.min(end, total);
  const duration = end - sourceIn;
  return duration >= 1 ? { sourceIn, duration } : null;
}

/**
 * Which tracks a selection lands on: the patched target tracks, unless the stream is
 * toggled off, missing from the media, or the target is locked. `override` is used by
 * drag-and-drop, which picks tracks under the pointer.
 */
export function placementTracks(tl: Timeline, media: MediaItem, sel: SourceSelection, override?: Partial<PlacementTracks>): PlacementTracks {
  const vId = override?.videoTrackId !== undefined ? override.videoTrackId : tl.targetVideoTrackId;
  const aId = override?.audioTrackId !== undefined ? override.audioTrackId : tl.targetAudioTrackId;
  const ok = (id: Id | null, kind: 'video' | 'audio') => !!id && getTrack(tl, id)?.kind === kind && !isTrackLocked(tl, id);
  return {
    videoTrackId: sel.video && media.hasVideo && ok(vId, 'video') ? vId : null,
    audioTrackId: sel.audio && media.hasAudio && ok(aId, 'audio') ? aId : null,
  };
}

function makeClips(media: MediaItem, tracks: PlacementTracks, at: Frame, sourceIn: Frame, duration: Frame, ids: IdGen): Clip[] {
  const linkId = tracks.videoTrackId && tracks.audioTrackId ? ids() : undefined;
  const base = { mediaId: media.id, start: at, duration, sourceIn };
  const clips: Clip[] = [];
  if (tracks.videoTrackId) clips.push({ ...base, id: ids(), trackId: tracks.videoTrackId, kind: 'video', ...(linkId ? { linkId } : {}) });
  if (tracks.audioTrackId) clips.push({ ...base, id: ids(), trackId: tracks.audioTrackId, kind: 'audio', ...(linkId ? { linkId } : {}) });
  return clips;
}

export interface PlaceResult {
  timeline: Timeline;
  /** Ids of the new clips (empty when nothing could be placed). */
  placed: Id[];
  /** Where the new material starts and ends, in the (possibly re-matched) timeline's frames. */
  range: Range | null;
}

function place(
  mode: 'insert' | 'overwrite',
  tl0: Timeline,
  media: MediaItem,
  sel: SourceSelection,
  at0: Frame,
  ids: IdGen,
  override?: Partial<PlacementTracks>,
): PlaceResult {
  // The first video clip decides the timeline format; rescale the drop point with it.
  const tl1 = autoMatchSettings(tl0, media);
  const at = Math.max(0, Math.round((at0 * tl1.settings.fps) / tl0.settings.fps));
  const src = sourceFrames(media, sel, tl1.settings.fps);
  const tracks = placementTracks(tl1, media, sel, override);
  if (!src || (!tracks.videoTrackId && !tracks.audioTrackId)) return { timeline: tl0, placed: [], range: null };

  const end = at + src.duration;
  const targetIds = [tracks.videoTrackId, tracks.audioTrackId].filter((t): t is Id => !!t);
  let tl = tl1;
  if (mode === 'insert') {
    // Like Premiere with sync lock on: every unlocked track opens up a gap at the insert point.
    const unlocked = unlockedTrackIds(tl);
    tl = splitAt(tl, unlocked, at, ids);
    tl = shiftClips(tl, unlocked, at, src.duration);
  } else {
    tl = clearRange(tl, targetIds, at, end, ids);
  }
  const clips = makeClips(media, tracks, at, src.sourceIn, src.duration, ids);
  return { timeline: setClips(tl, clips), placed: clips.map((c) => c.id), range: { start: at, end } };
}

/** `,` Insert: pushes everything at the playhead later on all unlocked tracks. */
export function insertEdit(
  tl: Timeline,
  media: MediaItem,
  sel: SourceSelection,
  at: Frame,
  ids: IdGen = defaultIds,
  override?: Partial<PlacementTracks>,
): PlaceResult {
  return place('insert', tl, media, sel, at, ids, override);
}

/** `.` Overwrite: replaces whatever is on the target tracks for the clip's length. */
export function overwriteEdit(
  tl: Timeline,
  media: MediaItem,
  sel: SourceSelection,
  at: Frame,
  ids: IdGen = defaultIds,
  override?: Partial<PlacementTracks>,
): PlaceResult {
  return place('overwrite', tl, media, sel, at, ids, override);
}

/**
 * Removes [start, end) from `clearTrackIds`, then closes the hole on every unlocked track
 * where that range is now empty. Tracks that still have material there (e.g. a music bed
 * spanning the cut) are left untouched, so they never get chopped implicitly.
 */
export function rippleDeleteRange(tl: Timeline, start: Frame, end: Frame, clearTrackIds: Id[], ids: IdGen = defaultIds): Timeline {
  if (end <= start) return tl;
  const cleared = clearRange(tl, clearTrackIds, start, end, ids);
  const shiftTracks = unlockedTrackIds(cleared).filter((t) => isRangeEmpty(cleared, t, start, end));
  return shiftClips(cleared, shiftTracks, end, -(end - start));
}

/** Shift+Delete: removes clips and leaves a gap. */
export function deleteClips(tl: Timeline, clipIds: Iterable<Id>): Timeline {
  return removeClips(tl, clipIds);
}

/** Delete / Backspace: removes clips and closes the gaps they leave. */
export function rippleDeleteClips(tl: Timeline, clipIds: Iterable<Id>, ids: IdGen = defaultIds): Timeline {
  const clips = [...clipIds].map((id) => tl.clips[id]).filter((c): c is Clip => !!c && !isTrackLocked(tl, c.trackId));
  if (clips.length === 0) return tl;
  const ranges = mergeRanges(clips.map((c) => ({ start: c.start, end: clipEnd(c) })));
  let out = removeClips(tl, clips.map((c) => c.id));
  for (const r of ranges.reverse()) out = rippleDeleteRange(out, r.start, r.end, [], ids);
  return out;
}

/** Closes a selected gap (Delete on a gap). */
export function closeGap(tl: Timeline, gap: Range, ids: IdGen = defaultIds): Timeline {
  return rippleDeleteRange(tl, gap.start, gap.end, [], ids);
}

/** `;` Lift: removes the range from all unlocked tracks, leaving a gap. */
export function liftRange(tl: Timeline, range: Range, ids: IdGen = defaultIds): Timeline {
  return clearRange(tl, unlockedTrackIds(tl), range.start, range.end, ids);
}

/** `'` Extract: removes the range from all unlocked tracks and closes the gap. */
export function extractRange(tl: Timeline, range: Range, ids: IdGen = defaultIds): Timeline {
  const out = rippleDeleteRange(tl, range.start, range.end, unlockedTrackIds(tl), ids);
  return { ...out, inPoint: null, outPoint: null };
}

/** Razor: splits specific clips at a frame. */
export function razorClips(tl: Timeline, clipIds: Iterable<Id>, frame: Frame, ids: IdGen = defaultIds): Timeline {
  const links = new IdRemap(ids);
  const updates: Clip[] = [];
  for (const id of new Set(clipIds)) {
    const c = tl.clips[id];
    if (!c || isTrackLocked(tl, c.trackId)) continue;
    const parts = splitClip(c, frame, ids, links);
    if (parts) updates.push(...parts);
  }
  return updates.length ? setClips(tl, updates) : tl;
}

/** Ctrl+K: cuts every unlocked track at the playhead. */
export function cutAllTracks(tl: Timeline, frame: Frame, ids: IdGen = defaultIds): Timeline {
  return splitAt(tl, unlockedTrackIds(tl), frame, ids);
}

/**
 * Q / W: ripple-trims the clip under the playhead (start or end) to the playhead.
 * Uses the targeted tracks; only when none of them has a clip under the playhead does it
 * look at other unlocked tracks (top video track first). The clip's linked partners are
 * trimmed with it. Q moves the playhead back to the new edit point.
 */
export function rippleTrimToPlayhead(
  tl: Timeline,
  playhead: Frame,
  side: 'start' | 'end',
  ids: IdGen = defaultIds,
): { timeline: Timeline; playhead: Frame } | null {
  const usable = (id: Id | null): id is Id => !!id && !isTrackLocked(tl, id);
  const targets = [tl.targetVideoTrackId, tl.targetAudioTrackId].filter(usable);
  const others = [...videoTracks(tl).reverse(), ...audioTracks(tl)].map((t) => t.id).filter((id) => usable(id) && !targets.includes(id));
  const under = (trackIds: Id[]) => trackIds.map((id) => clipAt(tl, id, playhead)).filter((c): c is Clip => !!c);
  let candidates = under(targets);
  if (candidates.length === 0) candidates = under(others);
  // Q with the playhead exactly on a cut has nothing to trim.
  const clip = candidates.find((c) => side === 'end' || c.start < playhead);
  if (!clip) return null;

  const range = side === 'start' ? { start: clip.start, end: playhead } : { start: playhead, end: clipEnd(clip) };
  const partners = linkedClips(tl, clip).filter((p) => p.start < range.end && clipEnd(p) > range.start);
  const tracks = [clip, ...partners].map((c) => c.trackId);
  return {
    timeline: rippleDeleteRange(tl, range.start, range.end, tracks, ids),
    playhead: side === 'start' ? clip.start : playhead,
  };
}
