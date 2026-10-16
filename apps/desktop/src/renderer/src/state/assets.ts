import { create } from 'zustand';
import { needsProxy, type MediaItem } from '@simplecut/core';
import type { AssetEvent, ThumbnailMeta } from '../../../shared/api';
import { api } from '../lib/api';

/**
 * Derived, machine-local assets for each media file (keyed by path): poster, waveform
 * peaks, filmstrip thumbnails and the editing proxy. Never saved in the project.
 */
export interface MediaAssets {
  poster?: string;
  waveform?: Uint8Array;
  thumbs?: { dir: string; meta: ThumbnailMeta };
  proxy?: { state: AssetEvent['state']; progress: number; path?: string; error?: string };
  /** The original file failed to play in the preview engine, so a proxy is required. */
  originalUnplayable?: boolean;
}

interface AssetsState {
  byPath: Record<string, MediaAssets>;
  /** Media ids whose file could not be found. */
  offline: Record<string, true>;
  patch(path: string, patch: Partial<MediaAssets>): void;
  setOffline(mediaId: string, offline: boolean): void;
}

export const useAssets = create<AssetsState>((set, get) => ({
  byPath: {},
  offline: {},
  patch(path, patch) {
    const byPath = get().byPath;
    set({ byPath: { ...byPath, [path]: { ...byPath[path], ...patch } } });
  },
  setOffline(mediaId, offline) {
    const next = { ...get().offline };
    if (offline) next[mediaId] = true;
    else delete next[mediaId];
    set({ offline: next });
  },
}));

let listening = false;

/** Subscribes once to background asset events from the main process. */
export function startAssetListener(): void {
  if (listening) return;
  listening = true;
  api.media.onAsset((e) => {
    const { patch } = useAssets.getState();
    if (e.kind === 'poster' && e.state === 'ready' && e.output) patch(e.path, { poster: api.mediaUrl(e.output) });
    if (e.kind === 'thumbnails' && e.state === 'ready' && e.output && e.thumbs) patch(e.path, { thumbs: { dir: e.output, meta: e.thumbs } });
    if (e.kind === 'waveform' && e.state === 'ready' && e.output) {
      fetch(api.mediaUrl(e.output))
        .then((r) => r.arrayBuffer())
        .then((buf) => useAssets.getState().patch(e.path, { waveform: new Uint8Array(buf) }))
        .catch(() => {});
    }
    if (e.kind === 'proxy') {
      const prev = useAssets.getState().byPath[e.path]?.proxy;
      patch(e.path, { proxy: { state: e.state, progress: e.progress ?? prev?.progress ?? 0, path: e.output ?? prev?.path, error: e.error } });
    }
  });
}

/** Starts poster/waveform/thumbnail/proxy generation for media (cached in main). */
export function prepareAssets(media: MediaItem, forceProxy = false): void {
  void api.media.prepare(media.path, media, { forceProxy }).catch(() => {});
}

/**
 * The URL the preview should play: the proxy when it is ready, otherwise the original
 * (even while a proxy is being made, so the user can start editing immediately).
 */
export function playableUrl(media: MediaItem, assets: MediaAssets | undefined): string | null {
  if (assets?.proxy?.state === 'ready' && assets.proxy.path) return api.mediaUrl(assets.proxy.path);
  if (assets?.originalUnplayable) return null;
  return api.mediaUrl(media.path);
}

/** A proxy is still being made and the preview may show the original (or nothing) meanwhile. */
export function proxyPending(media: MediaItem, assets: MediaAssets | undefined): boolean {
  if (assets?.proxy?.state === 'ready') return false;
  return needsProxy(media) || !!assets?.originalUnplayable;
}

/** Called by players when the browser can't decode the original: switch to a proxy. */
export function reportUnplayable(media: MediaItem): void {
  const a = useAssets.getState().byPath[media.path];
  if (a?.originalUnplayable || a?.proxy?.state === 'ready') return;
  useAssets.getState().patch(media.path, { originalUnplayable: true });
  prepareAssets(media, true);
}
