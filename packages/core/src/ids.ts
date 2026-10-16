import type { Id } from './types';

export type IdGen = () => Id;

/**
 * Short, unique-enough ids: a random per-generator salt plus a counter.
 * Pass a deterministic generator in tests.
 */
export function createIdGen(prefix = ''): IdGen {
  const salt = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  let n = 0;
  return () => `${prefix}${salt}${(++n).toString(36)}`;
}

/** Deterministic ids for tests: "id1", "id2", ... */
export function sequentialIds(prefix = 'id'): IdGen {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export const defaultIds: IdGen = createIdGen();
