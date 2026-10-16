import type { MediaInfo } from '../types';

/** Waveforms are stored as one peak per 10 ms (0-255). */
export const WAVEFORM_PEAKS_PER_SECOND = 100;
export const WAVEFORM_SAMPLE_RATE = 8000;

/** FFmpeg arguments that stream mono 8 kHz float samples to stdout for waveform drawing. */
export function waveformArgs(src: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:a:0', '-ac', '1', '-ar', String(WAVEFORM_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
}

/** Turns streamed float samples into peaks, chunk by chunk. */
export class PeakAccumulator {
  private readonly perPeak = WAVEFORM_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SECOND;
  private peaks: number[] = [];
  private count = 0;
  private max = 0;

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]!);
      if (v > this.max) this.max = v;
      if (++this.count === this.perPeak) this.flush();
    }
  }

  private flush(): void {
    this.peaks.push(Math.min(255, Math.round(Math.min(1, this.max) * 255)));
    this.count = 0;
    this.max = 0;
  }

  result(): Uint8Array {
    if (this.count > 0) this.flush();
    return Uint8Array.from(this.peaks);
  }
}

/** One small JPEG every N seconds for the timeline filmstrip (keyframes only: fast). */
export function thumbnailPlan(info: MediaInfo): { intervalSec: number; height: number } {
  const dur = Math.max(info.durationSec, 0.1);
  // ~1 per second for short clips, capped at 400 thumbnails.
  const intervalSec = Math.max(1, Math.ceil(dur / 400));
  return { intervalSec, height: 72 };
}

/** How many thumbnails a complete filmstrip has. */
export function expectedThumbnailCount(info: MediaInfo): number {
  return Math.max(1, Math.ceil(Math.max(info.durationSec, 0.1) / thumbnailPlan(info).intervalSec));
}

/**
 * Keyframes-only decoding is very fast but yields too few (even zero) thumbnails for files
 * with long GOPs (screen recordings, short clips with one keyframe); callers then retry
 * with `keyframesOnly: false`.
 */
export function thumbnailArgs(src: string, outPattern: string, info: MediaInfo, opts: { keyframesOnly?: boolean } = {}): string[] {
  const { intervalSec, height } = thumbnailPlan(info);
  const keyframesOnly = opts.keyframesOnly ?? true;
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(keyframesOnly ? ['-skip_frame', 'nokey'] : ['-hwaccel', 'auto']),
    '-i', src,
    '-map', '0:v:0',
    '-vf', `fps=1/${intervalSec},scale=-2:${height}`,
    '-q:v', '6',
    '-fps_mode', 'passthrough',
    outPattern,
  ];
}

/** A single larger frame for the media bin, from 10 % in (or the image itself). */
export function posterArgs(src: string, out: string, info: MediaInfo): string[] {
  const at = info.kind === 'video' ? Math.min(info.durationSec * 0.1, 5) : 0;
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(at > 0 ? ['-ss', at.toFixed(3)] : []),
    '-i', src,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '4',
    out,
  ];
}
