import type { BeatAnalysis } from '../types';

/**
 * Beat detection and music detection, in plain TypeScript (no platform APIs).
 *
 *  1. Onset envelope: spectral flux of the log-magnitude spectrum (how much "new" energy
 *     appears in each ~12 ms frame), plus a low-frequency version for kick drums.
 *  2. Tempo: autocorrelation of the envelope, weighted by a gentle preference for
 *     ~120 BPM so the classic double/half-tempo mistakes are rare.
 *  3. Beats: dynamic-programming beat tracker (D. Ellis, 2007) that balances landing on
 *     strong onsets with keeping a steady tempo.
 *  4. Downbeats: the bar phase (4/4) whose beats carry the most low-frequency energy.
 *  5. Music or not: a clear, steady pulse with little silence. Speech, game sound effects
 *     and drone motor noise don't have one.
 */

/** Analysis runs on mono audio at this rate (plenty for rhythm, cheap to decode). */
export const BEAT_SAMPLE_RATE = 11025;
const FFT_SIZE = 1024;
const HOP = 128;

/** FFmpeg arguments that stream mono float samples at BEAT_SAMPLE_RATE to stdout. */
export function beatAnalysisArgs(src: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:a:0', '-ac', '1', '-ar', String(BEAT_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
}

// ---------------------------------------------------------------------------
// FFT (radix-2, in place)
// ---------------------------------------------------------------------------

class FFT {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  constructor(private readonly n: number) {
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]!;
          const s = this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * c - im[b]! * s;
          const ti = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Onset envelope
// ---------------------------------------------------------------------------

export interface OnsetEnvelope {
  /** Full-band spectral flux per frame. */
  env: Float32Array;
  /** Low-frequency (< ~150 Hz) flux per frame: kick drums. */
  low: Float32Array;
  /** RMS level per frame. */
  rms: Float32Array;
  /** Frames per second. */
  frameRate: number;
  /** Seconds of the (center of) frame 0. */
  offsetSec: number;
}

export function onsetEnvelope(samples: Float32Array, sampleRate = BEAT_SAMPLE_RATE): OnsetEnvelope {
  const n = FFT_SIZE;
  const frames = samples.length >= n ? Math.floor((samples.length - n) / HOP) + 1 : 0;
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bins = n / 2;
  const lowBins = Math.max(2, Math.round((150 / sampleRate) * n));
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[off + i]!;
      sq += s * s;
      re[i] = s * window[i]!;
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / n);
    fft.forward(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      const v = Math.log1p(100 * mag);
      cur[k] = v;
      const d = v - prev[k]!;
      if (d > 0) {
        flux += d;
        if (k < lowBins) lowFlux += d;
      }
    }
    env[f] = f === 0 ? 0 : flux / bins;
    low[f] = f === 0 ? 0 : lowFlux / lowBins;
    const t = prev;
    prev = cur;
    cur = t;
  }
  // Remove the slowly varying part (crescendos, sustained sections) so only attacks remain.
  const detrended = subtractMovingAverage(env, Math.round((0.4 * sampleRate) / HOP));
  return { env: detrended, low: subtractMovingAverage(low, Math.round((0.4 * sampleRate) / HOP)), rms, frameRate: sampleRate / HOP, offsetSec: n / 2 / sampleRate };
}

function subtractMovingAverage(x: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(x.length);
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i]! + x[i]!;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(x.length, i + radius + 1);
    const mean = (prefix[b]! - prefix[a]!) / (b - a);
    out[i] = Math.max(0, x[i]! - mean);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

export const MIN_BPM = 60;
export const MAX_BPM = 200;

/** Normalized autocorrelation of the envelope for lags 0..maxLag. */
function autocorrelation(env: Float32Array, maxLag: number): Float64Array {
  let mean = 0;
  for (const v of env) mean += v;
  mean /= Math.max(1, env.length);
  const x = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) x[i] = env[i]! - mean;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < x.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i]! * x[i + lag]!;
    ac[lag] = s / (x.length - lag);
  }
  const zero = ac[0]! || 1;
  for (let lag = 0; lag <= maxLag; lag++) ac[lag] = ac[lag]! / zero;
  return ac;
}

export function estimateTempo(env: Float32Array, frameRate: number): { period: number; bpm: number; clarity: number } {
  const minLag = Math.floor((frameRate * 60) / MAX_BPM);
  const maxLag = Math.ceil((frameRate * 60) / MIN_BPM);
  const ac = autocorrelation(env, maxLag * 2 + 2);
  let best = -Infinity;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    // Gentle preference for moderate tempos (one octave standard deviation around 120 BPM).
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    // A real beat period also shows up at twice the lag (every other beat).
    const score = (ac[lag]! + 0.5 * (ac[2 * lag] ?? 0)) * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  // Parabolic interpolation for a sub-frame period.
  const y0 = ac[bestLag - 1] ?? ac[bestLag]!;
  const y1 = ac[bestLag]!;
  const y2 = ac[bestLag + 1] ?? ac[bestLag]!;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const period = bestLag + shift;
  return { period, bpm: (60 * frameRate) / period, clarity: Math.max(0, y1) };
}

// ---------------------------------------------------------------------------
// Beat tracking (dynamic programming)
// ---------------------------------------------------------------------------

export function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (n === 0 || !(period > 1)) return [];
  // Normalize and lightly smooth the envelope around each frame.
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let sd = 0;
  for (const v of env) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const width = Math.max(1, Math.round(period / 16));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let k = -width; k <= width; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const g = Math.exp(-0.5 * (k / (width / 2)) ** 2);
      s += g * (env[j]! / sd);
      w += g;
    }
    local[i] = s / w;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * period);
  const hi = Math.max(1, Math.round(period / 2));
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = t - lo; tau <= t - hi; tau++) {
      if (tau < 0) continue;
      const penalty = -tightness * Math.log((t - tau) / period) ** 2;
      const v = score[tau]! + penalty;
      if (v > best) {
        best = v;
        arg = tau;
      }
    }
    score[t] = local[t]! + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // Start from the last strong local maximum of the cumulative score.
  const maxima: number[] = [];
  for (let t = 1; t < n - 1; t++) if (score[t]! > score[t - 1]! && score[t]! >= score[t + 1]!) maxima.push(score[t]!);
  const sorted = [...maxima].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let last = n - 1;
  for (let t = n - 2; t > 0; t--) {
    if (score[t]! > score[t - 1]! && score[t]! >= score[t + 1]! && score[t]! >= 0.5 * median) {
      last = t;
      break;
    }
  }
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]!) {
    beats.push(t);
    if (back[t]! < 0) break;
  }
  beats.reverse();
  // Drop weak beats at the very start/end (fade-ins, silence).
  const strength = beats.map((b) => local[b]!);
  const threshold = 0.25 * (strength.reduce((a, b) => a + b, 0) / Math.max(1, strength.length));
  let a = 0;
  let b = beats.length;
  while (a < b && strength[a]! < threshold) a++;
  while (b > a && strength[b - 1]! < threshold) b--;
  return beats.slice(a, b);
}

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

export interface BeatDetails extends BeatAnalysis {
  /** Features behind the music/not-music decision (for tests and tuning). */
  features: { clarity: number; silenceRatio: number; beatStrength: number; durationSec: number; offbeatRatio?: number };
}

export function analyzeBeats(samples: Float32Array, sampleRate = BEAT_SAMPLE_RATE): BeatDetails {
  const durationSec = samples.length / sampleRate;
  const { env, low, rms, frameRate, offsetSec } = onsetEnvelope(samples, sampleRate);
  const empty: BeatDetails = {
    music: false,
    confidence: 0,
    bpm: 0,
    beats: [],
    downbeats: [],
    features: { clarity: 0, silenceRatio: 1, beatStrength: 0, durationSec },
  };
  if (env.length < frameRate * 3) return empty;

  let { period, bpm, clarity } = estimateTempo(env, frameRate);
  let frames = trackBeats(env, period);
  // Octave check: a backbeat pattern repeats every two beats, which can make the
  // autocorrelation prefer half the tempo. If the points halfway between the tracked
  // beats also carry strong attacks, the real pulse is twice as fast.
  // Loudness is compared on the raw samples: the log-compressed envelope makes quiet
  // off-beat hi-hats look as strong as kicks.
  const frameSec = (f: number) => f / frameRate + offsetSec;
  let offbeatRatio = 0;
  if ((60 * frameRate) / (period / 2) <= MAX_BPM && frames.length > 8) {
    let onBeats = 0;
    let between = 0;
    for (let i = 0; i + 1 < frames.length; i++) {
      const a = refineOnset(samples, sampleRate, frameSec(frames[i]!));
      const b = refineOnset(samples, sampleRate, frameSec(frames[i + 1]!));
      onBeats += attackStrength(samples, sampleRate, a);
      between += attackStrength(samples, sampleRate, refineOnset(samples, sampleRate, (a + b) / 2));
    }
    offbeatRatio = onBeats > 0 ? between / onBeats : 0;
    if (between >= 0.5 * onBeats) {
      period /= 2;
      bpm *= 2;
      frames = trackBeats(env, period);
    }
  }
  // Envelope frames are ~12 ms apart and the log spectral flux reacts as soon as a
  // transient enters the window, so place each beat on the sharpest energy rise in the
  // raw samples nearby (~3 ms resolution).
  const beats = frames.map((f) => refineOnset(samples, sampleRate, f / frameRate + offsetSec));

  // Bar phase (4/4): beats 1 and 3 are usually kick-dominant while 2 and 4 carry the
  // snare/clap, and the bar start is usually the more accented of the two.
  const kickness = frames.map((f) => (low[f] ?? 0) / ((env[f] ?? 0) + 1e-6));
  const strength = beats.map((sec) => attackStrength(samples, sampleRate, sec));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pair = mean(kickness.filter((_, i) => i % 2 === 0)) >= mean(kickness.filter((_, i) => i % 2 === 1)) ? 0 : 1;
  const phase = mean(strength.filter((_, i) => i % 4 === pair)) >= mean(strength.filter((_, i) => i % 4 === pair + 2)) ? pair : pair + 2;
  const downbeats = beats.filter((_, i) => i % 4 === phase);
  const refined = frames;

  // Features for "is this music?"
  const sortedRms = Float32Array.from(rms).sort();
  const loud = sortedRms[Math.floor(sortedRms.length * 0.95)] || 1e-9;
  let silent = 0;
  for (const r of rms) if (r < loud * 0.02) silent++;
  const silenceRatio = silent / rms.length;
  let envMean = 0;
  for (const v of env) envMean += v;
  envMean /= env.length;
  const atBeats = refined.reduce((s, f) => s + env[f]!, 0) / Math.max(1, refined.length);
  const beatStrength = envMean > 0 ? atBeats / envMean : 0;
  const music = durationSec >= 4 && clarity >= 0.15 && silenceRatio < 0.25 && beatStrength >= 1.5 && beats.length >= 8;

  return {
    music,
    confidence: Math.max(0, Math.min(1, (clarity - 0.1) / 0.4)),
    bpm: Math.round(bpm * 10) / 10,
    beats,
    downbeats,
    features: { clarity, silenceRatio, beatStrength, durationSec, offbeatRatio },
  };
}

/** How much louder (linear RMS) the 40 ms after `sec` are than the 40 ms before it. */
function attackStrength(samples: Float32Array, sampleRate: number, sec: number): number {
  const w = Math.round(0.04 * sampleRate);
  const guard = Math.round(0.005 * sampleRate);
  const at = Math.round(sec * sampleRate);
  const rms = (a: number, b: number) => {
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, a); i < Math.min(samples.length, b); i++) {
      s += samples[i]! * samples[i]!;
      n++;
    }
    return n ? Math.sqrt(s / n) : 0;
  };
  return Math.max(0, rms(at - guard, at + w) - rms(at - w, at - guard));
}

/**
 * Finds the attack nearest to `approxSec`: the block (~2.9 ms) with the largest rise in
 * log energy within [-60 ms, +40 ms]. Returns seconds rounded to the millisecond.
 */
function refineOnset(samples: Float32Array, sampleRate: number, approxSec: number): number {
  const block = 32;
  const from = Math.max(0, Math.floor(((approxSec - 0.06) * sampleRate) / block));
  const to = Math.min(Math.floor(samples.length / block) - 1, Math.ceil(((approxSec + 0.04) * sampleRate) / block));
  let prev = -Infinity;
  let bestRise = -Infinity;
  let best = approxSec;
  for (let b = from - 1; b <= to; b++) {
    if (b < 0) continue;
    let e = 1e-10;
    for (let i = b * block; i < (b + 1) * block; i++) e += samples[i]! * samples[i]!;
    const le = Math.log(e);
    if (b >= from && le - prev > bestRise) {
      bestRise = le - prev;
      best = (b * block) / sampleRate;
    }
    prev = le;
  }
  return Math.round(best * 1000) / 1000;
}

/** Beat times (seconds into the media) that fall inside a clip, as timeline frames. */
export function beatFramesInClip(
  analysis: BeatAnalysis,
  clip: { start: number; duration: number; sourceIn: number },
  fps: number,
  which: 'beats' | 'downbeats' = 'beats',
): number[] {
  const out: number[] = [];
  for (const sec of analysis[which]) {
    const f = clip.start + Math.round(sec * fps) - clip.sourceIn;
    if (f >= clip.start && f < clip.start + clip.duration) out.push(f);
  }
  return out;
}
