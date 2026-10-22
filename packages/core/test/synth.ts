/** Deterministic synthetic audio for the beat-detection tests. */

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A simple dance-music loop: kick on every beat (louder on bar starts), snare on 2 and 4,
 * hi-hats on eighths, and a sustained bass/pad so the track is never silent.
 * Returns the samples and the true beat / downbeat times.
 */
export function drumLoop(opts: { bpm: number; seconds: number; sampleRate: number; offsetSec?: number; seed?: number }) {
  const { bpm, seconds, sampleRate: sr } = opts;
  const offset = opts.offsetSec ?? 0.25;
  const rand = rng(opts.seed ?? 1);
  const out = new Float32Array(Math.round(seconds * sr));
  const beat = 60 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  const add = (t0: number, len: number, fn: (t: number) => number) => {
    const s0 = Math.round(t0 * sr);
    for (let i = 0; i < len * sr && s0 + i < out.length; i++) out[s0 + i]! += fn(i / sr);
  };
  for (let i = 0; offset + i * beat < seconds - 0.3; i++) {
    const t = offset + i * beat;
    beats.push(t);
    const bar = i % 4 === 0;
    if (bar) downbeats.push(t);
    add(t, 0.25, (x) => (bar ? 0.9 : 0.6) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-x * 30)) * x) * Math.exp(-x * 12));
    if (i % 4 === 1 || i % 4 === 3) add(t, 0.18, (x) => 0.35 * (rand() * 2 - 1) * Math.exp(-x * 25));
    for (const half of [0, 0.5]) add(t + half * beat, 0.04, (x) => 0.08 * (rand() * 2 - 1) * Math.exp(-x * 90));
  }
  // Sustained harmony underneath.
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i]! += 0.06 * Math.sin(2 * Math.PI * 110 * t) + 0.04 * Math.sin(2 * Math.PI * 164.8 * t) + 0.03 * Math.sin(2 * Math.PI * 220 * t);
  }
  return { samples: out, beats, downbeats };
}

/** Speech-like: noisy syllables at an irregular 3–7 per second, in phrases separated by pauses. */
export function speechLike(seconds: number, sampleRate: number, seed = 7): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let t = 0.2;
  let lp = 0;
  while (t < seconds - 1) {
    const phraseEnd = t + 1 + rand() * 2.5;
    while (t < phraseEnd) {
      const len = 0.08 + rand() * 0.18;
      const f0 = 110 + rand() * 90;
      const s0 = Math.round(t * sampleRate);
      for (let i = 0; i < len * sampleRate && s0 + i < out.length; i++) {
        const x = i / sampleRate;
        const env = Math.min(1, x / 0.02) * Math.min(1, (len - x) / 0.04);
        lp = 0.7 * lp + 0.3 * (rand() * 2 - 1);
        out[s0 + i] = env * (0.25 * Math.sin(2 * Math.PI * f0 * x) * (1 + 0.5 * Math.sin(2 * Math.PI * 3 * f0 * x)) + 0.15 * lp);
      }
      t += len + 0.03 + rand() * 0.12;
    }
    t += 0.3 + rand() * 0.7;
  }
  return out;
}

/** A drone or FPV quad: steady motor tones plus wind noise, no rhythm. */
export function motorDrone(seconds: number, sampleRate: number, seed = 3): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const wobble = 1 + 0.03 * Math.sin(2 * Math.PI * 0.3 * t);
    lp = 0.9 * lp + 0.1 * (rand() * 2 - 1);
    out[i] = 0.2 * Math.sin(2 * Math.PI * 190 * wobble * t) + 0.1 * Math.sin(2 * Math.PI * 380 * wobble * t) + 0.2 * lp;
  }
  return out;
}
