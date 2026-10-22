import { WAVEFORM_PEAKS_PER_SECOND } from '../media/analysis';
import { clipEnd, clipsOnTrack, isTrackAudible } from '../timeline/query';
import type { Clip, Frame, MediaItem, Timeline, Track } from '../types';

/**
 * Audio mix math shared by the real-time preview (Web Audio) and the export (FFmpeg).
 * Everything is a pure function of the timeline so both produce the same levels.
 */

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export const MIN_VOLUME_DB = -40;
export const MAX_VOLUME_DB = 15;
export const DEFAULT_DUCK_DB = -12;

/** Fade lengths actually used (they never overlap and never exceed the clip). */
export function effectiveFades(clip: Pick<Clip, 'duration' | 'fadeIn' | 'fadeOut'>): { fadeIn: Frame; fadeOut: Frame } {
  let fadeIn = Math.max(0, Math.round(clip.fadeIn ?? 0));
  let fadeOut = Math.max(0, Math.round(clip.fadeOut ?? 0));
  if (fadeIn + fadeOut > clip.duration) {
    const scale = clip.duration / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * scale);
    fadeOut = Math.floor(fadeOut * scale);
  }
  return { fadeIn, fadeOut };
}

/**
 * Clip gain at a (fractional) timeline frame: volume × linear fade-in × linear fade-out
 * (FFmpeg afade's default "tri" curve).
 */
export function clipGainAt(clip: Clip, frame: number): number {
  const { fadeIn, fadeOut } = effectiveFades(clip);
  const local = frame - clip.start;
  let g = dbToGain(clip.volumeDb ?? 0);
  if (fadeIn > 0 && local < fadeIn) g *= Math.max(0, local / fadeIn);
  const fromEnd = clipEnd(clip) - frame;
  if (fadeOut > 0 && fromEnd < fadeOut) g *= Math.max(0, fromEnd / fadeOut);
  return g;
}

/** Constant-power crossfade (FFmpeg acrossfade c1=qsin:c2=qsin). `weight` 0 → all A, 1 → all B. */
export function crossfadeGains(weight: number): { a: number; b: number } {
  const w = Math.min(1, Math.max(0, weight));
  return { a: Math.cos((w * Math.PI) / 2), b: Math.sin((w * Math.PI) / 2) };
}

export function trackGain(track: Track): number {
  return dbToGain(track.volumeDb ?? 0);
}

// ---------------------------------------------------------------------------
// Auto-ducking
// ---------------------------------------------------------------------------

/** A stretch of dialogue, in timeline seconds. */
export interface DuckRegion {
  start: number;
  end: number;
}

export const DUCK_ATTACK = 0.25;
export const DUCK_RELEASE = 0.6;
/** Ducking starts a little before the voice (we know what's coming). */
export const DUCK_LOOKAHEAD = 0.1;
/** Peak level (0..255 waveform scale) that counts as someone talking. */
const SPEECH_THRESHOLD = 20;

/**
 * Where people are talking: every audible track that isn't the music track, read from
 * the waveform peaks (one per 10 ms). Short pauses are bridged and tiny blips dropped, and
 * regions closer than a full duck cycle are merged so their gain ramps never overlap.
 */
export function dialogueRegions(tl: Timeline, media: Record<string, MediaItem | undefined>, peaks: Record<string, Uint8Array | undefined>): DuckRegion[] {
  const fps = tl.settings.fps;
  const step = 1 / WAVEFORM_PEAKS_PER_SECOND;
  const active: number[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== 'audio' || track.music || !isTrackAudible(tl, track)) continue;
    for (const c of clipsOnTrack(tl, track.id)) {
      const m = media[c.mediaId];
      const p = m ? peaks[m.path] : undefined;
      if (!p) continue;
      const gain = dbToGain(c.volumeDb ?? 0) * trackGain(track);
      const startSec = c.start / fps;
      const n = Math.floor((c.duration / fps) * WAVEFORM_PEAKS_PER_SECOND);
      const src0 = (c.sourceIn / fps) * WAVEFORM_PEAKS_PER_SECOND;
      const speed = c.speed ?? 1;
      for (let i = 0; i < n; i++) {
        const v = p[Math.round(src0 + i * speed)];
        if (v !== undefined && v * gain >= SPEECH_THRESHOLD) active.push(Math.round((startSec + i * step) * WAVEFORM_PEAKS_PER_SECOND));
      }
    }
  }
  if (!active.length) return [];
  active.sort((a, b) => a - b);
  const raw: DuckRegion[] = [];
  let s = active[0]!;
  let e = s;
  for (const slot of active.slice(1)) {
    if (slot - e <= 35) e = slot; // bridge pauses up to 350 ms
    else {
      raw.push({ start: s * step, end: (e + 1) * step });
      s = e = slot;
    }
  }
  raw.push({ start: s * step, end: (e + 1) * step });
  const kept = raw.filter((r) => r.end - r.start >= 0.15);
  const merged: DuckRegion[] = [];
  const cycle = DUCK_ATTACK + DUCK_RELEASE + DUCK_LOOKAHEAD;
  for (const r of kept) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < cycle) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** How deep the duck is at time t, 0..1 (trapezoid: ramp down before speech, ramp back up after). */
export function duckAmountAt(regions: DuckRegion[], t: number): number {
  let sum = 0;
  for (const r of regions) {
    const a = r.start - DUCK_LOOKAHEAD - DUCK_ATTACK;
    const b = r.end + DUCK_RELEASE;
    if (t <= a || t >= b) continue;
    sum += Math.min(1, (t - a) / DUCK_ATTACK) * Math.min(1, (b - t) / DUCK_RELEASE);
  }
  return Math.min(1, sum);
}

export function duckGainAt(regions: DuckRegion[], t: number, depthDb: number): number {
  return dbToGain(depthDb * duckAmountAt(regions, t));
}

/**
 * The same envelope as FFmpeg `volume` expressions (eval=frame), relative to `offsetSec`
 * (the export range start). Split into several chained filters so no single expression
 * gets too long.
 */
export function duckVolumeFilters(regions: DuckRegion[], depthDb: number, offsetSec: number, rangeSec: number): string[] {
  const f = (x: number) => x.toFixed(4);
  const relevant = regions.filter((r) => r.end + DUCK_RELEASE > offsetSec && r.start - DUCK_LOOKAHEAD - DUCK_ATTACK < offsetSec + rangeSec);
  const filters: string[] = [];
  for (let i = 0; i < relevant.length; i += 150) {
    const terms = relevant.slice(i, i + 150).map((r) => {
      const a = r.start - DUCK_LOOKAHEAD - DUCK_ATTACK - offsetSec;
      const b = r.end + DUCK_RELEASE - offsetSec;
      return `clip((t-${f(a)})/${DUCK_ATTACK},0,1)*clip((${f(b)}-t)/${DUCK_RELEASE},0,1)`;
    });
    filters.push(`volume=volume='pow(10,${depthDb}*clip(${terms.join('+')},0,1)/20)':eval=frame`);
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Loudness normalization (YouTube plays back at −14 LUFS)
// ---------------------------------------------------------------------------

export const YOUTUBE_LUFS = -14;
export const MAX_TRUE_PEAK = -1;

/** Parses the JSON block FFmpeg's loudnorm filter prints (print_format=json). */
export function parseLoudnorm(stderr: string): { integratedLufs: number; truePeakDb: number } | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const i = Number(j.input_i);
    const tp = Number(j.input_tp);
    if (!Number.isFinite(i) || !Number.isFinite(tp)) return null;
    return { integratedLufs: i, truePeakDb: tp };
  } catch {
    return null;
  }
}

/**
 * Master gain that brings the mix to −14 LUFS without pushing true peaks above −1 dBTP.
 * A static gain keeps preview and export identical (no limiter coloring the sound).
 */
export function normalizationGain(m: { integratedLufs: number; truePeakDb: number }): { gainDb: number; limitedByPeak: boolean } {
  if (!Number.isFinite(m.integratedLufs) || m.integratedLufs < -70) return { gainDb: 0, limitedByPeak: false };
  const wanted = YOUTUBE_LUFS - m.integratedLufs;
  const headroom = MAX_TRUE_PEAK - m.truePeakDb;
  const gainDb = Math.round(Math.min(wanted, headroom) * 10) / 10;
  return { gainDb, limitedByPeak: headroom < wanted };
}

// ---------------------------------------------------------------------------
// Noise reduction
// ---------------------------------------------------------------------------

/** Strength is stored in 10 % steps so the cleaned audio can be cached and reused. */
export const denoiseStep = (strength: number) => Math.round(Math.min(1, Math.max(0, strength)) * 10) / 10;

/**
 * FFmpeg arguments that write the media's audio with background noise reduced (FFT
 * denoiser, adaptive noise tracking). The whole file is processed once and cached, and
 * both the preview and the export play that file, so they always match.
 */
export function denoiseArgs(src: string, out: string, strength: number): string[] {
  const s = denoiseStep(strength);
  const nr = (6 + 30 * s).toFixed(1);
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a:0', '-af', `afftdn=nr=${nr}:nf=-40:tn=1`, '-c:a', 'flac', '-progress', 'pipe:1', '-nostats', out];
}
