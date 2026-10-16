/**
 * Unlimited undo/redo as a list of immutable snapshots. Because edits share structure
 * with previous states, each entry costs only what changed.
 *
 * entries[index] is the current state. Undo/redo just moves the index; a new edit after
 * an undo discards the redo branch, like every mainstream editor.
 */
export interface HistoryEntry<T> {
  /** Stable id (used for "saved at" tracking and list keys). */
  id: number;
  label: string;
  state: T;
  time: number;
}

export interface History<T> {
  entries: HistoryEntry<T>[];
  index: number;
  nextId: number;
}

export function createHistory<T>(state: T, label = 'Start', time = Date.now()): History<T> {
  return { entries: [{ id: 1, label, state, time }], index: 0, nextId: 2 };
}

export function currentState<T>(h: History<T>): T {
  return h.entries[h.index]!.state;
}

export function currentEntry<T>(h: History<T>): HistoryEntry<T> {
  return h.entries[h.index]!;
}

/** Records a new state. No-op if the state object is unchanged. */
export function pushHistory<T>(h: History<T>, label: string, state: T, time = Date.now()): History<T> {
  if (state === currentState(h)) return h;
  const entries = h.entries.slice(0, h.index + 1);
  entries.push({ id: h.nextId, label, state, time });
  return { entries, index: entries.length - 1, nextId: h.nextId + 1 };
}

export const canUndo = <T>(h: History<T>) => h.index > 0;
export const canRedo = <T>(h: History<T>) => h.index < h.entries.length - 1;

export function undo<T>(h: History<T>): History<T> {
  return canUndo(h) ? { ...h, index: h.index - 1 } : h;
}

export function redo<T>(h: History<T>): History<T> {
  return canRedo(h) ? { ...h, index: h.index + 1 } : h;
}

/** Jump straight to an entry from the history list. */
export function jumpTo<T>(h: History<T>, index: number): History<T> {
  if (index < 0 || index >= h.entries.length || index === h.index) return h;
  return { ...h, index };
}
