import { expect } from 'vitest';
import {
  clipEnd,
  clipsOnTrack,
  createTimeline,
  sequentialIds,
  trackLabel,
  type Clip,
  type MediaItem,
  type Timeline,
} from '../src';

export function videoMedia(id: string, durationSec = 60, extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    path: `C:\\Media\\${id}.mp4`,
    kind: 'video',
    durationSec,
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    fps: 30,
    avgFps: 30,
    isVFR: false,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixFmt: 'yuv420p',
    bitRate: 8_000_000,
    audioChannels: 2,
    audioSampleRate: 48000,
    rotation: 0,
    fileSize: 1000,
    ...extra,
  };
}

export function audioMedia(id: string, durationSec = 120): MediaItem {
  return {
    ...videoMedia(id, durationSec),
    name: `${id}.mp3`,
    path: `C:\\Media\\${id}.mp3`,
    kind: 'audio',
    hasVideo: false,
    width: 0,
    height: 0,
    fps: 0,
    avgFps: 0,
    videoCodec: null,
    pixFmt: null,
    audioCodec: 'mp3',
  };
}

export function imageMedia(id: string): MediaItem {
  return {
    ...videoMedia(id, 0),
    name: `${id}.png`,
    path: `C:\\Media\\${id}.png`,
    kind: 'image',
    hasAudio: false,
    fps: 0,
    avgFps: 0,
    videoCodec: 'png',
    pixFmt: 'rgba',
    audioCodec: null,
    audioChannels: 0,
  };
}

/** A fresh 3V + 3A timeline (V1..V3 = t1..t3, A1..A3 = t4..t6) at 30 fps, plus an id generator. */
export function setup() {
  const tl = createTimeline(sequentialIds('t'));
  const ids = sequentialIds('c');
  return { tl, ids, V1: 't1', V2: 't2', V3: 't3', A1: 't4', A2: 't5', A3: 't6' };
}

/** Adds a clip directly (bypassing edit operations) for test setup. */
export function put(tl: Timeline, clip: Partial<Clip> & Pick<Clip, 'id' | 'trackId' | 'start' | 'duration'>): Timeline {
  const full: Clip = { mediaId: 'm1', kind: tl.tracks.find((t) => t.id === clip.trackId)!.kind, sourceIn: 0, ...clip };
  return { ...tl, clips: { ...tl.clips, [full.id]: full } };
}

/**
 * Compact layout: { V1: "0-90 m1@0 | 120-150 m2@30", ... }. Only tracks with clips appear.
 * Each clip prints as start-end media@sourceIn.
 */
export function layout(tl: Timeline): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tl.tracks) {
    const clips = clipsOnTrack(tl, t.id);
    if (clips.length) out[trackLabel(tl, t.id)] = clips.map((c) => `${c.start}-${clipEnd(c)} ${c.mediaId}@${c.sourceIn}`).join(' | ');
  }
  return out;
}

/** Asserts timeline invariants: no overlaps, positive durations, valid tracks, kinds match. */
export function expectValid(tl: Timeline): void {
  for (const c of Object.values(tl.clips)) {
    const track = tl.tracks.find((t) => t.id === c.trackId);
    expect(track, `clip ${c.id} on missing track`).toBeTruthy();
    expect(track!.kind).toBe(c.kind);
    expect(c.duration).toBeGreaterThanOrEqual(1);
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.sourceIn).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(c.start) && Number.isInteger(c.duration) && Number.isInteger(c.sourceIn)).toBe(true);
  }
  for (const t of tl.tracks) {
    const clips = clipsOnTrack(tl, t.id);
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i]!.start, `overlap on ${trackLabel(tl, t.id)}`).toBeGreaterThanOrEqual(clipEnd(clips[i - 1]!));
    }
  }
}

/** Ids of clips that share the given clip's linkId (including itself). */
export function linkGroup(tl: Timeline, clipId: string): string[] {
  const c = tl.clips[clipId]!;
  if (!c.linkId) return [clipId];
  return Object.values(tl.clips)
    .filter((o) => o.linkId === c.linkId)
    .map((o) => o.id)
    .sort();
}
