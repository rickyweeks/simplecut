import { create } from 'zustand';
import type { Id } from '@simplecut/core';

/**
 * Source monitor state. Times are in seconds (not frames) so marks survive the timeline
 * changing frame rate when the first clip auto-matches it.
 */
interface SourceState {
  mediaId: Id | null;
  /** Current position, seconds. */
  timeSec: number;
  /** In mark, seconds, or null. */
  inSec: number | null;
  /** Out mark as an exclusive end in seconds (the marked frame is included), or null. */
  outSec: number | null;
  /** V / A source toggles: which streams insert/overwrite bring in. */
  video: boolean;
  audio: boolean;
  playing: boolean;
  rate: number;
  set(patch: Partial<Omit<SourceState, 'set' | 'load'>>): void;
  load(mediaId: Id | null): void;
}

/** Remembered marks per media item, so switching clips and back keeps your In/Out. */
const remembered = new Map<Id, { timeSec: number; inSec: number | null; outSec: number | null }>();

export const useSource = create<SourceState>((set, get) => ({
  mediaId: null,
  timeSec: 0,
  inSec: null,
  outSec: null,
  video: true,
  audio: true,
  playing: false,
  rate: 0,
  set: (patch) => set(patch),
  load(mediaId) {
    const cur = get();
    if (cur.mediaId) remembered.set(cur.mediaId, { timeSec: cur.timeSec, inSec: cur.inSec, outSec: cur.outSec });
    const prev = mediaId ? remembered.get(mediaId) : undefined;
    set({ mediaId, timeSec: prev?.timeSec ?? 0, inSec: prev?.inSec ?? null, outSec: prev?.outSec ?? null, playing: false, rate: 0 });
  },
}));
