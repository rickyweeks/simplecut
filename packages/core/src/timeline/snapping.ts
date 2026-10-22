import type { Frame, Id, Timeline } from '../types';
import { clipEnd } from './query';

/**
 * Frames things snap to: playhead, clip edges, markers, In/Out and 0, plus `extra` (e.g.
 * the music's beats). Sorted and unique.
 */
export function snapTargets(tl: Timeline, opts: { playhead?: Frame; exclude?: Iterable<Id>; extra?: Frame[] } = {}): Frame[] {
  const exclude = new Set(opts.exclude ?? []);
  const set = new Set<Frame>([0]);
  if (opts.playhead != null) set.add(opts.playhead);
  for (const c of Object.values(tl.clips)) {
    if (exclude.has(c.id)) continue;
    set.add(c.start);
    set.add(clipEnd(c));
  }
  for (const m of tl.markers) set.add(m.frame);
  if (tl.inPoint != null) set.add(tl.inPoint);
  if (tl.outPoint != null) set.add(tl.outPoint + 1);
  for (const f of opts.extra ?? []) set.add(f);
  return [...set].sort((a, b) => a - b);
}

/** Nearest target within `threshold` frames, or null. */
export function snapFrame(targets: Frame[], frame: Frame, threshold: number): Frame | null {
  let best: Frame | null = null;
  let bestDist = threshold + 1e-9;
  // Binary search for the insertion point, then check neighbours.
  let lo = 0;
  let hi = targets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid]! < frame) lo = mid + 1;
    else hi = mid;
  }
  for (const i of [lo - 1, lo]) {
    const t = targets[i];
    if (t === undefined) continue;
    const dist = Math.abs(t - frame);
    if (dist <= bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * For a block being dragged, finds the smallest correction that puts any of its edges on a
 * target. `edges` are the edge positions with the current (unsnapped) delta applied.
 */
export function snapEdges(targets: Frame[], edges: Frame[], threshold: number): { correction: Frame; at: Frame } | null {
  let best: { correction: Frame; at: Frame } | null = null;
  for (const e of edges) {
    const t = snapFrame(targets, e, threshold);
    if (t == null) continue;
    const correction = t - e;
    if (!best || Math.abs(correction) < Math.abs(best.correction)) best = { correction, at: t };
  }
  return best;
}
