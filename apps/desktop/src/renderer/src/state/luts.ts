import { create } from 'zustand';
import type { CubeLut } from '@simplecut/core';
import { api } from '../lib/api';

/**
 * Imported .cube LUTs, read through the main process once per path. The preview shows a
 * clip ungraded for the moment its LUT is loading (and if it can't be read).
 */

type Entry = CubeLut | 'loading' | { error: string };

export const useLuts = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));

/** The parsed LUT, undefined while loading, or null if it can't be read. */
export function inputLut(path: string): CubeLut | null | undefined {
  const e = useLuts.getState().entries[path];
  if (e === undefined) {
    load(path);
    return undefined;
  }
  if (e === 'loading') return undefined;
  return 'error' in e ? null : e;
}

export const lutError = (path: string): string | null => {
  const e = useLuts.getState().entries[path];
  return e && e !== 'loading' && 'error' in e ? e.error : null;
};

function load(path: string): void {
  const set = (e: Entry) => useLuts.setState((s) => ({ entries: { ...s.entries, [path]: e } }));
  set('loading');
  api.media.readLut(path).then(set, (err: unknown) => set({ error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) }));
}

/** Forget a LUT (e.g. after re-importing a changed file). */
export function reloadLut(path: string): void {
  useLuts.setState((s) => {
    const entries = { ...s.entries };
    delete entries[path];
    return { entries };
  });
}
