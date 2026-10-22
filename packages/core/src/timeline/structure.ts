import type { IdGen } from '../ids';
import {
  FORMATS,
  FRAME_RATES,
  type Clip,
  type FormatPreset,
  type FrameRate,
  type Frame,
  type Id,
  type Marker,
  type MediaInfo,
  type Timeline,
  type Track,
  type TrackKind,
} from '../types';
import { setClips, withIds } from './primitives';
import { clipsOnTrack, getTrack, isTrackLocked, linkedClips, tracksOfKind } from './query';

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export function createTrack(kind: TrackKind, ids: IdGen): Track {
  return { id: ids(), kind, locked: false, muted: false, solo: false, hidden: false };
}

/** Adds a video track above the top one, or an audio track below the bottom one. */
export function addTrack(tl: Timeline, kind: TrackKind, ids: IdGen): Timeline {
  const track = createTrack(kind, ids);
  const tracks = [...tl.tracks];
  if (kind === 'video') {
    const lastVideo = tracks.map((t) => t.kind).lastIndexOf('video');
    tracks.splice(lastVideo + 1, 0, track);
  } else {
    tracks.push(track);
  }
  return { ...tl, tracks };
}

/** Removes an empty track (keeps at least one of each kind). */
export function removeTrack(tl: Timeline, trackId: Id): Timeline {
  const track = getTrack(tl, trackId);
  if (!track || clipsOnTrack(tl, trackId).length > 0) return tl;
  if (tracksOfKind(tl, track.kind).length <= 1) return tl;
  return {
    ...tl,
    tracks: tl.tracks.filter((t) => t.id !== trackId),
    targetVideoTrackId: tl.targetVideoTrackId === trackId ? null : tl.targetVideoTrackId,
    targetAudioTrackId: tl.targetAudioTrackId === trackId ? null : tl.targetAudioTrackId,
  };
}

export type TrackFlags = Partial<Pick<Track, 'locked' | 'muted' | 'solo' | 'hidden' | 'volumeDb' | 'music'>>;

export function updateTrack(tl: Timeline, trackId: Id, patch: TrackFlags): Timeline {
  // Only one music track at a time.
  const tracks = tl.tracks.map((t) => {
    if (t.id === trackId) return { ...t, ...patch };
    if (patch.music && t.music) return { ...t, music: false };
    return t;
  });
  return { ...tl, tracks };
}

/** Clip properties that can be changed in place (Inspector, handles on the clip). */
export type ClipProps = Partial<Pick<Clip, 'volumeDb' | 'fadeIn' | 'fadeOut' | 'denoise' | 'text'>>;

/** Changes properties of clips (skipping locked tracks). Undefined values remove the property. */
export function updateClips(tl: Timeline, clipIds: Id[], patch: ClipProps): Timeline {
  const updates: Clip[] = [];
  for (const id of clipIds) {
    const c = tl.clips[id];
    if (!c || isTrackLocked(tl, c.trackId)) continue;
    const next: Clip = { ...c, ...patch };
    for (const k of Object.keys(patch) as (keyof ClipProps)[]) if (patch[k] === undefined) delete next[k];
    updates.push(next);
  }
  return updates.length ? setClips(tl, updates) : tl;
}

/** Source patching: which track insert/overwrite uses. Null turns that stream off. */
export function setTargetTrack(tl: Timeline, kind: TrackKind, trackId: Id | null): Timeline {
  if (trackId && getTrack(tl, trackId)?.kind !== kind) return tl;
  return kind === 'video' ? { ...tl, targetVideoTrackId: trackId } : { ...tl, targetAudioTrackId: trackId };
}

// ---------------------------------------------------------------------------
// Link / group
// ---------------------------------------------------------------------------

/** Ctrl+L: unlinks if any selected clip is linked to something, otherwise links the selection. */
export function toggleLink(tl: Timeline, clipIds: Id[], ids: IdGen): Timeline {
  const clips = clipIds.map((id) => tl.clips[id]).filter((c) => c !== undefined);
  if (clips.length === 0) return tl;
  const anyLinked = clips.some((c) => linkedClips(tl, c).length > 0);
  if (anyLinked) {
    const linkIds = new Set(clips.map((c) => c.linkId).filter(Boolean));
    const affected = Object.values(tl.clips).filter((c) => c.linkId && linkIds.has(c.linkId));
    return setClips(tl, affected.map((c) => withIds(c, undefined, c.groupId)));
  }
  if (clips.length < 2) return tl;
  const linkId = ids();
  return setClips(tl, clips.map((c) => withIds(c, linkId, c.groupId)));
}

/** Ctrl+G: ungroups if any selected clip is grouped, otherwise groups the selection. */
export function toggleGroup(tl: Timeline, clipIds: Id[], ids: IdGen): Timeline {
  const clips = clipIds.map((id) => tl.clips[id]).filter((c) => c !== undefined);
  if (clips.length === 0) return tl;
  const groupIds = new Set(clips.map((c) => c.groupId).filter(Boolean));
  if (groupIds.size > 0) {
    const affected = Object.values(tl.clips).filter((c) => c.groupId && groupIds.has(c.groupId));
    return setClips(tl, affected.map((c) => withIds(c, c.linkId, undefined)));
  }
  if (clips.length < 2) return tl;
  const groupId = ids();
  return setClips(tl, clips.map((c) => withIds(c, c.linkId, groupId)));
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** M: adds a marker at a frame. If one is already there, the timeline is unchanged. */
export function addMarker(tl: Timeline, frame: Frame, ids: IdGen, init: Partial<Omit<Marker, 'id' | 'frame'>> = {}): Timeline {
  if (tl.markers.some((m) => m.frame === frame)) return tl;
  const marker: Marker = { id: ids(), frame, label: '', color: 'green', chapter: false, ...init };
  return { ...tl, markers: [...tl.markers, marker].sort((a, b) => a.frame - b.frame) };
}

export function updateMarker(tl: Timeline, markerId: Id, patch: Partial<Omit<Marker, 'id'>>): Timeline {
  return {
    ...tl,
    markers: tl.markers.map((m) => (m.id === markerId ? { ...m, ...patch } : m)).sort((a, b) => a.frame - b.frame),
  };
}

export function removeMarker(tl: Timeline, markerId: Id): Timeline {
  return { ...tl, markers: tl.markers.filter((m) => m.id !== markerId) };
}

// ---------------------------------------------------------------------------
// Timeline In / Out
// ---------------------------------------------------------------------------

export function setInPoint(tl: Timeline, frame: Frame | null): Timeline {
  const outPoint = frame != null && tl.outPoint != null && frame > tl.outPoint ? null : tl.outPoint;
  return { ...tl, inPoint: frame, outPoint };
}

/** Out is inclusive, like Premiere. */
export function setOutPoint(tl: Timeline, frame: Frame | null): Timeline {
  const inPoint = frame != null && tl.inPoint != null && frame < tl.inPoint ? null : tl.inPoint;
  return { ...tl, inPoint, outPoint: frame };
}

export function clearInOut(tl: Timeline): Timeline {
  return { ...tl, inPoint: null, outPoint: null };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function nearestFrameRate(fps: number): FrameRate {
  if (!(fps > 0)) return 30;
  let best: FrameRate = 30;
  for (const r of FRAME_RATES) if (Math.abs(r - fps) < Math.abs(best - fps)) best = r;
  return best;
}

/** The format/frame rate a timeline adopts when this media is its first clip. */
export function matchFormatToMedia(media: Pick<MediaInfo, 'width' | 'height' | 'fps' | 'kind'>): {
  format: FormatPreset;
  fps: FrameRate;
} {
  const { width: w, height: h } = media;
  const format: FormatPreset = h > w ? 'vertical' : Math.max(w, h) >= 2880 || Math.min(w, h) >= 1600 ? '4k' : '1080p';
  return { format, fps: media.kind === 'video' ? nearestFrameRate(media.fps) : 30 };
}

/**
 * Auto-match: the first video (or image) placed on an unlocked, empty timeline decides its
 * format and frame rate. Audio-only media leaves the timeline undecided.
 */
export function autoMatchSettings(tl: Timeline, media: MediaInfo): Timeline {
  if (tl.settings.locked || Object.keys(tl.clips).length > 0 || !media.hasVideo) return tl;
  const { format, fps } = matchFormatToMedia(media);
  return changeSettings(tl, { format, fps });
}

/** The frame grid a media item will be edited on (used by the source monitor). */
export function effectiveFps(tl: Timeline, media?: MediaInfo): FrameRate {
  if (tl.settings.locked || !media || !media.hasVideo || Object.keys(tl.clips).length > 0) return tl.settings.fps;
  return matchFormatToMedia(media).fps;
}

/** Changes format and/or frame rate (rescaling every frame position) and locks the settings. */
export function changeSettings(tl: Timeline, patch: { format?: FormatPreset; fps?: FrameRate }): Timeline {
  const format = patch.format ?? tl.settings.format;
  const fps = patch.fps ?? tl.settings.fps;
  if (!FORMATS[format]) return tl;
  const ratio = fps / tl.settings.fps;
  const scale = (f: Frame) => Math.round(f * ratio);
  let next: Timeline = { ...tl, settings: { ...tl.settings, format, fps, locked: true } };
  if (ratio !== 1) {
    const clips = Object.fromEntries(
      Object.values(tl.clips).map((c) => {
        const start = scale(c.start);
        const end = Math.max(start + 1, scale(c.start + c.duration));
        return [c.id, { ...c, start, duration: end - start, sourceIn: scale(c.sourceIn) }];
      }),
    );
    next = {
      ...next,
      clips,
      markers: tl.markers.map((m) => ({ ...m, frame: scale(m.frame) })),
      inPoint: tl.inPoint == null ? null : scale(tl.inPoint),
      outPoint: tl.outPoint == null ? null : scale(tl.outPoint),
    };
  }
  return next;
}
