import type { Clip, Frame, Id, Timeline, Transition, TransitionType, VideoTransitionType } from '../types';
import { setClips } from './primitives';
import { clipEnd, clipsOnTrack, getTrack, isTrackLocked } from './query';

/**
 * Transitions.
 *
 * A two-sided transition sits on the cut between clip A and the clip B that starts exactly
 * where A ends, and is stored as `B.transitionIn`. It spans D frames centered on the cut:
 * [cut − h2, cut + h1) with h1 = floor(D/2), h2 = D − h1.
 *  - dissolve / slide / crossfade overlap A and B, so A plays on past its out point and B
 *    starts before its in point (media "handles"; frozen frames if the media runs out).
 *  - dips don't overlap: A fades to the color over its last h2 frames, B fades in from it
 *    over its first h1 frames.
 * With no clip right before B, `transitionIn` fades B in over D frames; with no clip right
 * after A, `A.transitionOut` fades A out over its last D frames. Fading "from nothing"
 * reveals whatever is on lower tracks (black on V1).
 *
 * The per-frame math here is what FFmpeg's xfade / fade / acrossfade produce, so the
 * preview matches the export (measured, see the export integration tests).
 */

export const DEFAULT_TRANSITION_SECONDS = 1;
export const VIDEO_TRANSITIONS: VideoTransitionType[] = ['dissolve', 'dipBlack', 'dipWhite', 'slide'];
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  dissolve: 'Cross Dissolve',
  dipBlack: 'Dip to Black',
  dipWhite: 'Dip to White',
  slide: 'Slide',
  crossfade: 'Audio Crossfade',
};

export const isOverlapping = (t: TransitionType) => t === 'dissolve' || t === 'slide' || t === 'crossfade';

/** The clip that ends exactly where `clip` starts, on the same track. */
export function previousAdjacent(tl: Timeline, clip: Clip): Clip | undefined {
  return clipsOnTrack(tl, clip.trackId).find((c) => c.id !== clip.id && clipEnd(c) === clip.start);
}

export function nextAdjacent(tl: Timeline, clip: Clip): Clip | undefined {
  return clipsOnTrack(tl, clip.trackId).find((c) => c.id !== clip.id && c.start === clipEnd(clip));
}

export type ResolvedTransition =
  | { kind: 'cut'; type: TransitionType; a: Clip; b: Clip; cut: Frame; duration: Frame; h1: Frame; h2: Frame }
  | { kind: 'in'; type: TransitionType; clip: Clip; duration: Frame }
  | { kind: 'out'; type: TransitionType; clip: Clip; duration: Frame };

/** Every transition on a track, with durations clamped to what the clips allow. */
export function trackTransitions(tl: Timeline, trackId: Id): ResolvedTransition[] {
  const out: ResolvedTransition[] = [];
  const clips = clipsOnTrack(tl, trackId);
  clips.forEach((c, i) => {
    const prev = i > 0 && clipEnd(clips[i - 1]!) === c.start ? clips[i - 1]! : undefined;
    const next = i + 1 < clips.length && clips[i + 1]!.start === clipEnd(c) ? clips[i + 1]! : undefined;
    if (c.transitionIn && c.transitionIn.duration > 0) {
      if (prev) {
        // Each half must fit inside its own clip.
        const max = 2 * Math.min(prev.duration, c.duration);
        const duration = Math.max(2, Math.min(c.transitionIn.duration, max));
        const h1 = Math.floor(duration / 2);
        out.push({ kind: 'cut', type: c.transitionIn.type, a: prev, b: c, cut: c.start, duration, h1, h2: duration - h1 });
      } else {
        out.push({ kind: 'in', type: c.transitionIn.type, clip: c, duration: Math.min(c.transitionIn.duration, c.duration) });
      }
    }
    if (c.transitionOut && c.transitionOut.duration > 0 && !next) {
      out.push({ kind: 'out', type: c.transitionOut.type, clip: c, duration: Math.min(c.transitionOut.duration, c.duration) });
    }
  });
  return out;
}

/** The frames a resolved transition covers, [start, end). */
export function transitionSpan(t: ResolvedTransition): { start: Frame; end: Frame } {
  if (t.kind === 'cut') return { start: t.cut - t.h2, end: t.cut + t.h1 };
  if (t.kind === 'in') return { start: t.clip.start, end: t.clip.start + t.duration };
  return { start: clipEnd(t.clip) - t.duration, end: clipEnd(t.clip) };
}

/**
 * Frames during which each clip on a track must play: its own range, extended into the
 * neighbour's side of overlapping transitions (dissolve, slide, crossfade). [from, to).
 */
export function clipPlaySpans(tl: Timeline, trackId: Id): Map<Id, { clip: Clip; from: Frame; to: Frame }> {
  const spans = new Map<Id, { clip: Clip; from: Frame; to: Frame }>();
  for (const c of clipsOnTrack(tl, trackId)) spans.set(c.id, { clip: c, from: c.start, to: clipEnd(c) });
  for (const t of trackTransitions(tl, trackId)) {
    if (t.kind !== 'cut' || !isOverlapping(t.type)) continue;
    spans.get(t.a.id)!.to = t.cut + t.h1;
    spans.get(t.b.id)!.from = t.cut - t.h2;
  }
  return spans;
}

/** Crossfade weight of an audio clip at a frame (1 outside any crossfade or fade). */
export function audioTransitionGain(tl: Timeline, clip: Clip, frame: number): number {
  let g = 1;
  for (const t of trackTransitions(tl, clip.trackId)) {
    const span = transitionSpan(t);
    if (frame < span.start || frame >= span.end) continue;
    if (t.kind === 'cut') {
      if (t.type !== 'crossfade') continue;
      const w = (frame - span.start) / t.duration;
      if (t.a.id === clip.id) g *= Math.cos((w * Math.PI) / 2);
      if (t.b.id === clip.id) g *= Math.sin((w * Math.PI) / 2);
    } else if (t.clip.id === clip.id && t.type === 'crossfade') {
      // A crossfade with nothing on the other side is a plain (linear) fade.
      const local = frame - span.start;
      g *= t.kind === 'in' ? Math.max(0, Math.min(1, local / t.duration)) : Math.max(0, Math.min(1, 1 - local / t.duration));
    }
  }
  return g;
}

/**
 * How a frame on a track should be drawn when a transition is involved.
 *  - 'blend': draw A, then B on top with `weight` (dissolve), or push-slide by `weight`.
 *  - 'fade': draw `clip`, then overlay `color` with opacity 1 − factor (dips; 'none' = transparent).
 */
export type TransitionFrame =
  | { mode: 'blend'; type: 'dissolve' | 'slide'; a: Clip; b: Clip; weight: number }
  | { mode: 'fade'; clip: Clip; factor: number; color: 'black' | 'white' | 'none' };

/** fade filter semantics: fade-in factor i/n over frames 0..n-1; fade-out 1 − i/n over the last n. */
export const fadeInFactor = (i: Frame, n: Frame) => (n <= 0 ? 1 : Math.min(1, Math.max(0, i / n)));
export const fadeOutFactor = (i: Frame, n: Frame) => (n <= 0 ? 1 : Math.min(1, Math.max(0, 1 - i / n)));

const fadeColor = (type: TransitionType): 'black' | 'white' | 'none' => (type === 'dipBlack' ? 'black' : type === 'dipWhite' ? 'white' : 'none');

export function transitionFrameAt(tl: Timeline, trackId: Id, frame: Frame): TransitionFrame | null {
  for (const t of trackTransitions(tl, trackId)) {
    const span = transitionSpan(t);
    if (frame < span.start || frame >= span.end) continue;
    if (t.kind === 'cut') {
      if (t.type === 'dissolve' || t.type === 'slide') {
        return { mode: 'blend', type: t.type, a: t.a, b: t.b, weight: (frame - span.start) / t.duration };
      }
      if (t.type === 'crossfade') continue;
      // Dips: A fades out before the cut, B fades in after it.
      if (frame < t.cut) return { mode: 'fade', clip: t.a, factor: fadeOutFactor(frame - (t.cut - t.h2), t.h2), color: fadeColor(t.type) };
      return { mode: 'fade', clip: t.b, factor: fadeInFactor(frame - t.cut, t.h1), color: fadeColor(t.type) };
    }
    if (t.type === 'crossfade') continue;
    if (t.kind === 'in') return { mode: 'fade', clip: t.clip, factor: fadeInFactor(frame - span.start, t.duration), color: fadeColor(t.type) };
    return { mode: 'fade', clip: t.clip, factor: fadeOutFactor(frame - span.start, t.duration), color: fadeColor(t.type) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Ctrl+D / Shift+Ctrl+D: the cut a default transition applies to. Uses the edit point
 * nearest the playhead on the given track (within `reach` frames).
 */
export function cutNearPlayhead(tl: Timeline, trackId: Id, playhead: Frame, reach: Frame): { clip: Clip; edge: 'in' | 'out' } | null {
  let best: { clip: Clip; edge: 'in' | 'out'; dist: number } | null = null;
  const clips = clipsOnTrack(tl, trackId);
  for (const c of clips) {
    const dIn = Math.abs(c.start - playhead);
    if (dIn <= reach && (!best || dIn < best.dist)) best = { clip: c, edge: 'in', dist: dIn };
    const dOut = Math.abs(clipEnd(c) - playhead);
    if (dOut <= reach && !nextAdjacent(tl, c) && (!best || dOut < best.dist)) best = { clip: c, edge: 'out', dist: dOut };
  }
  return best ? { clip: best.clip, edge: best.edge } : null;
}

/** Adds (or replaces) a transition at a clip's start ('in') or end ('out'). */
export function setTransition(tl: Timeline, clipId: Id, edge: 'in' | 'out', transition: Transition | null): Timeline {
  const clip = tl.clips[clipId];
  if (!clip || isTrackLocked(tl, clip.trackId)) return tl;
  const track = getTrack(tl, clip.trackId);
  if (transition && (transition.type === 'crossfade') !== (track?.kind === 'audio')) return tl;
  // An "out" transition only exists where nothing follows; otherwise it belongs to the next clip.
  if (edge === 'out' && transition) {
    const next = nextAdjacent(tl, clip);
    if (next) return setTransition(tl, next.id, 'in', transition);
  }
  const key = edge === 'in' ? 'transitionIn' : 'transitionOut';
  const { [key]: _old, ...rest } = clip;
  const updated: Clip = transition ? { ...rest, [key]: { type: transition.type, duration: Math.max(2, Math.round(transition.duration)) } } : (rest as Clip);
  return setClips(tl, [updated]);
}
