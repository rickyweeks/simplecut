import { describe, expect, it } from 'vitest';
import { BEAT_SAMPLE_RATE, analyzeBeats, beatFramesInClip } from '../src';
import { drumLoop, motorDrone, speechLike } from './synth';

const SR = BEAT_SAMPLE_RATE;

/** Fraction of true times that have a detected time within `tol` seconds. */
function hitRate(truth: number[], found: number[], tol: number): number {
  let hits = 0;
  for (const t of truth) if (found.some((f) => Math.abs(f - t) <= tol)) hits++;
  return hits / truth.length;
}

describe('beat detection', () => {
  for (const bpm of [90, 128, 150]) {
    it(`finds the beats of a ${bpm} BPM track and calls it music`, () => {
      const { samples, beats } = drumLoop({ bpm, seconds: 30, sampleRate: SR, offsetSec: 0.37 });
      const r = analyzeBeats(samples);
      expect(r.music, JSON.stringify(r.features)).toBe(true);
      expect(Math.abs(r.bpm - bpm)).toBeLessThan(2);
      // Ignore the first and last second (the tracker needs context at the edges).
      const inner = beats.filter((t) => t > 1 && t < 29);
      expect(hitRate(inner, r.beats, 0.035)).toBeGreaterThan(0.9);
      // No phantom beats between real ones.
      expect(r.beats.length).toBeLessThan(beats.length * 1.1);
      expect(r.confidence).toBeGreaterThan(0.3);
    });
  }

  it('finds the bar starts (downbeats)', () => {
    const { samples, downbeats } = drumLoop({ bpm: 120, seconds: 30, sampleRate: SR, offsetSec: 0.5 });
    const r = analyzeBeats(samples);
    const inner = downbeats.filter((t) => t > 1 && t < 29);
    expect(hitRate(inner, r.downbeats, 0.035)).toBeGreaterThan(0.85);
  });

  it('does not call speech music', () => {
    const r = analyzeBeats(speechLike(30, SR));
    expect(r.music, JSON.stringify(r.features)).toBe(false);
  });

  it('does not call drone / FPV motor noise music', () => {
    const r = analyzeBeats(motorDrone(30, SR));
    expect(r.music, JSON.stringify(r.features)).toBe(false);
  });

  it('handles silence and very short audio', () => {
    expect(analyzeBeats(new Float32Array(SR * 10)).music).toBe(false);
    expect(analyzeBeats(new Float32Array(SR)).beats).toEqual([]);
  });

  it('maps beats into a clip on the timeline', () => {
    const analysis = { music: true, confidence: 1, bpm: 120, beats: [0.5, 1, 1.5, 2, 2.5], downbeats: [0.5, 2.5] };
    // Clip uses source 1.0 s – 2.0 s and starts at timeline frame 300 (30 fps).
    expect(beatFramesInClip(analysis, { start: 300, duration: 31, sourceIn: 30 }, 30)).toEqual([300, 315, 330]);
    expect(beatFramesInClip(analysis, { start: 0, duration: 90, sourceIn: 0 }, 30, 'downbeats')).toEqual([15, 75]);
    expect(beatFramesInClip(analysis, { start: 0, duration: 60, sourceIn: 0 }, 30, 'downbeats')).toEqual([15]);
  });

  it('is fast enough for a 4-minute song', () => {
    const { samples } = drumLoop({ bpm: 124, seconds: 240, sampleRate: SR });
    const t0 = Date.now();
    analyzeBeats(samples);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 20000);
});
