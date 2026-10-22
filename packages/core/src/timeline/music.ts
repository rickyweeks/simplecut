import { beatFramesInClip } from '../audio/beats';
import { defaultIds, type IdGen } from '../ids';
import type { Frame, Id, MediaItem, Timeline } from '../types';
import { overwriteEdit } from './edit';
import { setClips, splitClip, IdRemap } from './primitives';
import { audioTracks, clipEnd, clipsOnTrack, isTrackLocked } from './query';
import { addMarker, addTrack, updateTrack } from './structure';

/**
 * "Add music": songs go on a dedicated music track. Clips there get beat markers and beat
 * snapping, and the track ducks under dialogue automatically. No guessing whether audio is
 * music: whatever the user adds this way is.
 */

export function musicTrack(tl: Timeline): Id | null {
  return audioTracks(tl).find((t) => t.music)?.id ?? null;
}

/**
 * Finds the music track, or makes one: the first empty, unlocked audio track that isn't
 * the dialogue target (A1 by default), or a new track at the bottom.
 */
export function ensureMusicTrack(tl: Timeline, ids: IdGen = defaultIds): { timeline: Timeline; trackId: Id } {
  const existing = audioTracks(tl).find((t) => t.music && !t.locked);
  if (existing) return { timeline: tl, trackId: existing.id };
  const empty = audioTracks(tl).find((t) => !t.locked && t.id !== tl.targetAudioTrackId && clipsOnTrack(tl, t.id).length === 0);
  let out = tl;
  let trackId = empty?.id;
  if (!trackId) {
    out = addTrack(out, 'audio', ids);
    trackId = audioTracks(out).at(-1)!.id;
  }
  return { timeline: updateTrack(out, trackId, { music: true }), trackId };
}

/** Puts a song on the music track, after whatever is already there. */
export function addMusic(tl: Timeline, media: MediaItem, ids: IdGen = defaultIds): { timeline: Timeline; clipId: Id | null; trackId: Id } {
  const { timeline: withTrack, trackId } = ensureMusicTrack(tl, ids);
  const at = Math.max(0, ...clipsOnTrack(withTrack, trackId).map(clipEnd));
  const r = overwriteEdit(withTrack, media, { mediaId: media.id, inSec: 0, outSec: null, video: false, audio: true }, at, ids, {
    videoTrackId: null,
    audioTrackId: trackId,
  });
  return { timeline: r.timeline, clipId: r.placed[0] ?? null, trackId };
}

/** Beat (or bar) positions of every analysed clip on music tracks, as sorted timeline frames. */
export function musicBeatFrames(tl: Timeline, media: Record<Id, MediaItem | undefined>, which: 'beats' | 'downbeats' = 'beats'): Frame[] {
  const out = new Set<Frame>();
  for (const t of audioTracks(tl)) {
    if (!t.music) continue;
    for (const c of clipsOnTrack(tl, t.id)) {
      const analysis = media[c.mediaId]?.beats;
      if (analysis) for (const f of beatFramesInClip(analysis, c, tl.settings.fps, which)) out.add(f);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Adds a timeline marker on every beat or every bar of the music (skipping existing ones). */
export function addBeatMarkers(tl: Timeline, media: Record<Id, MediaItem | undefined>, which: 'beats' | 'downbeats', ids: IdGen = defaultIds): Timeline {
  let out = tl;
  for (const f of musicBeatFrames(tl, media, which)) out = addMarker(out, f, ids, { color: which === 'downbeats' ? 'orange' : 'yellow' });
  return out;
}

/**
 * "Cut on the beat": splits the given clips at every beat (or bar) that falls inside them,
 * so a montage can be trimmed to the music by deleting pieces.
 */
export function cutClipsOnBeats(tl: Timeline, clipIds: Id[], beatFrames: Frame[], ids: IdGen = defaultIds): Timeline {
  let out = tl;
  const links = new IdRemap(ids);
  for (const id of clipIds) {
    let current = out.clips[id];
    if (!current || isTrackLocked(out, current.trackId)) continue;
    for (const f of beatFrames) {
      if (f <= current.start || f >= clipEnd(current)) continue;
      const parts = splitClip(current, f, ids, links);
      if (!parts) continue;
      out = setClips(out, parts);
      current = parts[1];
    }
  }
  return out;
}
