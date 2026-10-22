import type { Clip, Frame, Id, Range, Timeline, Track, TrackKind } from '../types';

export const clipEnd = (c: Clip): Frame => c.start + c.duration;

export function videoTracks(tl: Timeline): Track[] {
  return tl.tracks.filter((t) => t.kind === 'video');
}

export function audioTracks(tl: Timeline): Track[] {
  return tl.tracks.filter((t) => t.kind === 'audio');
}

export function tracksOfKind(tl: Timeline, kind: TrackKind): Track[] {
  return tl.tracks.filter((t) => t.kind === kind);
}

export function getTrack(tl: Timeline, trackId: Id): Track | undefined {
  return tl.tracks.find((t) => t.id === trackId);
}

/** 0-based index of a track among tracks of the same kind (V1 = 0, A1 = 0). */
export function trackIndex(tl: Timeline, trackId: Id): number {
  const track = getTrack(tl, trackId);
  if (!track) return -1;
  return tracksOfKind(tl, track.kind).indexOf(track);
}

/** "V1", "A2", ... */
export function trackLabel(tl: Timeline, trackId: Id): string {
  const track = getTrack(tl, trackId);
  if (!track) return '?';
  return `${track.kind === 'video' ? 'V' : 'A'}${trackIndex(tl, trackId) + 1}`;
}

export function unlockedTrackIds(tl: Timeline): Id[] {
  return tl.tracks.filter((t) => !t.locked).map((t) => t.id);
}

export function isTrackLocked(tl: Timeline, trackId: Id): boolean {
  return getTrack(tl, trackId)?.locked ?? true;
}

/** Whether an audio track is heard, taking mute and solo into account. */
export function isTrackAudible(tl: Timeline, track: Track): boolean {
  if (track.kind !== 'audio' || track.muted) return false;
  const anySolo = tl.tracks.some((t) => t.kind === 'audio' && t.solo);
  return anySolo ? track.solo : true;
}

// Per-track sorted clip lists, cached per `clips` object. Edits always create a new
// `clips` object, so the cache can never go stale.
const trackCache = new WeakMap<Record<Id, Clip>, Map<Id, Clip[]>>();

export function clipsOnTrack(tl: Timeline, trackId: Id): Clip[] {
  let byTrack = trackCache.get(tl.clips);
  if (!byTrack) {
    byTrack = new Map();
    for (const c of Object.values(tl.clips)) {
      const list = byTrack.get(c.trackId);
      if (list) list.push(c);
      else byTrack.set(c.trackId, [c]);
    }
    for (const list of byTrack.values()) list.sort((a, b) => a.start - b.start);
    trackCache.set(tl.clips, byTrack);
  }
  return byTrack.get(trackId) ?? [];
}

/** The clip covering `frame` on a track (start <= frame < end). */
export function clipAt(tl: Timeline, trackId: Id, frame: Frame): Clip | undefined {
  const list = clipsOnTrack(tl, trackId);
  // Binary search for the last clip starting at or before frame.
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start <= frame) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return undefined;
  const c = list[found]!;
  return frame < clipEnd(c) ? c : undefined;
}

/** Clips on a track that overlap [start, end). */
export function clipsInRange(tl: Timeline, trackId: Id, start: Frame, end: Frame): Clip[] {
  return clipsOnTrack(tl, trackId).filter((c) => c.start < end && clipEnd(c) > start);
}

export function isRangeEmpty(tl: Timeline, trackId: Id, start: Frame, end: Frame): boolean {
  return clipsInRange(tl, trackId, start, end).length === 0;
}

/** End of the last clip on any track. */
export function timelineDuration(tl: Timeline): Frame {
  let end = 0;
  for (const c of Object.values(tl.clips)) end = Math.max(end, clipEnd(c));
  return end;
}

/** All clip starts and ends (sorted, unique), optionally limited to some tracks. */
export function editPoints(tl: Timeline, trackIds?: Id[]): Frame[] {
  const set = new Set<Frame>();
  const allowed = trackIds ? new Set(trackIds) : null;
  for (const c of Object.values(tl.clips)) {
    if (allowed && !allowed.has(c.trackId)) continue;
    set.add(c.start);
    set.add(clipEnd(c));
  }
  return [...set].sort((a, b) => a - b);
}

export function prevEditPoint(tl: Timeline, frame: Frame): Frame | null {
  const points = editPoints(tl);
  for (let i = points.length - 1; i >= 0; i--) if (points[i]! < frame) return points[i]!;
  return null;
}

export function nextEditPoint(tl: Timeline, frame: Frame): Frame | null {
  for (const p of editPoints(tl)) if (p > frame) return p;
  return null;
}

/** Other clips sharing this clip's link (not including the clip itself). */
export function linkedClips(tl: Timeline, clip: Clip): Clip[] {
  if (!clip.linkId) return [];
  return Object.values(tl.clips).filter((c) => c.linkId === clip.linkId && c.id !== clip.id);
}

export function isLinked(tl: Timeline, clip: Clip): boolean {
  return linkedClips(tl, clip).length > 0;
}

/**
 * Expands a selection with linked clips and grouped clips, the way a click selects
 * in Premiere. Repeats until stable so links and groups can chain.
 */
export function expandSelection(
  tl: Timeline,
  clipIds: Iterable<Id>,
  opts: { linked?: boolean; grouped?: boolean } = {},
): Id[] {
  const { linked = true, grouped = true } = opts;
  const result = new Set<Id>();
  const queue = [...clipIds].filter((id) => tl.clips[id]);
  const all = Object.values(tl.clips);
  while (queue.length) {
    const id = queue.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const clip = tl.clips[id]!;
    for (const other of all) {
      if (result.has(other.id)) continue;
      if ((linked && clip.linkId && other.linkId === clip.linkId) || (grouped && clip.groupId && other.groupId === clip.groupId)) {
        queue.push(other.id);
      }
    }
  }
  return [...result];
}

/** Empty stretches on one track, from frame 0 up to `until` (defaults to the timeline end). */
export function trackGaps(tl: Timeline, trackId: Id, until: Frame = timelineDuration(tl)): Range[] {
  const gaps: Range[] = [];
  let cursor = 0;
  for (const c of clipsOnTrack(tl, trackId)) {
    if (c.start > cursor) gaps.push({ start: cursor, end: Math.min(c.start, until) });
    cursor = Math.max(cursor, clipEnd(c));
    if (cursor >= until) break;
  }
  if (cursor < until) gaps.push({ start: cursor, end: until });
  return gaps.filter((g) => g.end > g.start);
}

/** The gap on a track that contains `frame`, if any (bounded by the timeline end). */
export function gapAt(tl: Timeline, trackId: Id, frame: Frame): Range | null {
  return trackGaps(tl, trackId).find((g) => g.start <= frame && frame < g.end) ?? null;
}

/**
 * Ranges where no visible video track has a clip, so the output would be black.
 * Empty when the timeline has no video at all (an audio-only project is not a mistake).
 */
export function blackGaps(tl: Timeline): Range[] {
  const visible = videoTracks(tl).filter((t) => !t.hidden);
  const covered: Range[] = [];
  for (const t of visible) for (const c of clipsOnTrack(tl, t.id)) covered.push({ start: c.start, end: clipEnd(c) });
  if (covered.length === 0) return [];
  const end = timelineDuration(tl);
  const merged = mergeRanges(covered);
  const gaps: Range[] = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

/** Sorts and merges overlapping or touching ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The timeline In/Out range as [start, end), or null when neither mark is set. */
export function markedRange(tl: Timeline): Range | null {
  if (tl.inPoint == null && tl.outPoint == null) return null;
  const start = tl.inPoint ?? 0;
  const end = tl.outPoint != null ? tl.outPoint + 1 : Math.max(timelineDuration(tl), start + 1);
  return end > start ? { start, end } : null;
}

// ---------------------------------------------------------------------------
// Speed: timeline time -> source time
// ---------------------------------------------------------------------------

export const clipSpeed = (c: Pick<Clip, 'speed'>): number => c.speed ?? 1;

/** Source position (in timeline-rate frames, possibly fractional) shown at timeline frame `f`. */
export function sourceFrameAt(c: Pick<Clip, 'start' | 'sourceIn' | 'speed'>, f: number): number {
  return c.sourceIn + (f - c.start) * clipSpeed(c);
}

/** How many source frames `frames` timeline frames of the clip use. */
export const sourceSpan = (c: Pick<Clip, 'speed'>, frames: number): number => frames * clipSpeed(c);

/** Timeline length for `sourceFrames` of source at the clip's speed. */
export const timelineSpan = (c: Pick<Clip, 'speed'>, sourceFrames: number): Frame => Math.max(1, Math.round(sourceFrames / clipSpeed(c)));

/** Keeps fractional source positions tidy (no 0.30000000000000004 in project files). */
export const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;
