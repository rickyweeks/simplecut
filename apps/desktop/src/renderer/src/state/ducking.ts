import { dialogueRegions, type DuckRegion, type Timeline } from '@simplecut/core';
import { useAssets } from './assets';
import { getDoc } from './project';

/**
 * Dialogue regions the music track ducks under, recomputed only when the clips, tracks
 * or waveforms change. The export receives the same regions, so it ducks identically.
 */
let key: [unknown, unknown, unknown, unknown] | null = null;
let cached: DuckRegion[] = [];

export function duckRegionsFor(tl: Timeline): DuckRegion[] {
  const media = getDoc().media;
  const assets = useAssets.getState().byPath;
  if (key && key[0] === tl.clips && key[1] === tl.tracks && key[2] === assets && key[3] === media) return cached;
  // Nothing to duck without a music track.
  if (!tl.tracks.some((t) => t.music)) {
    cached = [];
  } else {
    const peaks: Record<string, Uint8Array | undefined> = {};
    for (const [path, a] of Object.entries(assets)) peaks[path] = a.waveform;
    cached = dialogueRegions(tl, media, peaks);
  }
  key = [tl.clips, tl.tracks, assets, media];
  return cached;
}
