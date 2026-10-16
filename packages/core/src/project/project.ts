import { defaultIds, type IdGen } from '../ids';
import type { Id, MediaInfo, MediaItem, ProjectDoc, Timeline } from '../types';
import { createTrack } from '../timeline/structure';
import { basename } from './paths';

export const DEFAULT_VIDEO_TRACKS = 3;
export const DEFAULT_AUDIO_TRACKS = 3;

export function createTimeline(ids: IdGen = defaultIds): Timeline {
  const video = Array.from({ length: DEFAULT_VIDEO_TRACKS }, () => createTrack('video', ids));
  const audio = Array.from({ length: DEFAULT_AUDIO_TRACKS }, () => createTrack('audio', ids));
  return {
    settings: { format: '1080p', fps: 30, sampleRate: 48000, locked: false },
    tracks: [...video, ...audio],
    clips: {},
    markers: [],
    inPoint: null,
    outPoint: null,
    targetVideoTrackId: video[0]!.id,
    targetAudioTrackId: audio[0]!.id,
  };
}

export function createProjectDoc(ids: IdGen = defaultIds): ProjectDoc {
  return { media: {}, timeline: createTimeline(ids) };
}

export function createMediaItem(info: MediaInfo, path: string, ids: IdGen = defaultIds, name = basename(path)): MediaItem {
  return { ...info, id: ids(), name, path };
}

export function addMedia(doc: ProjectDoc, items: MediaItem[]): ProjectDoc {
  if (!items.length) return doc;
  const media = { ...doc.media };
  for (const m of items) media[m.id] = m;
  return { ...doc, media };
}

/** Removes media and every clip that uses it. */
export function removeMedia(doc: ProjectDoc, mediaIds: Id[]): ProjectDoc {
  const drop = new Set(mediaIds);
  const media = Object.fromEntries(Object.entries(doc.media).filter(([id]) => !drop.has(id)));
  const clips = Object.fromEntries(Object.entries(doc.timeline.clips).filter(([, c]) => !drop.has(c.mediaId)));
  return { media, timeline: { ...doc.timeline, clips } };
}

/** Relink or refresh media info (e.g. after the user locates a moved file). */
export function updateMedia(doc: ProjectDoc, mediaId: Id, patch: Partial<Omit<MediaItem, 'id'>>): ProjectDoc {
  const m = doc.media[mediaId];
  if (!m) return doc;
  return { ...doc, media: { ...doc.media, [mediaId]: { ...m, ...patch } } };
}

export function mediaUsageCount(doc: ProjectDoc, mediaId: Id): number {
  return Object.values(doc.timeline.clips).filter((c) => c.mediaId === mediaId).length;
}
