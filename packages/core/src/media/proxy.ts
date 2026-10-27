import { proxyVideoArgs, type VideoEncoderId } from '../export/encoders';
import type { MediaInfo } from '../types';

/**
 * Proxies are lightweight stand-ins used only for preview. Export always reads the original.
 * The user never has to know they exist: they are made automatically in the background.
 */
export type ProxyReason =
  /** Variable frame rate: conform to constant so frame stepping is exact. */
  | 'vfr'
  /** Larger than 1440p: too heavy to scrub smoothly. */
  | 'resolution'
  /** Very high bitrate (e.g. 100 Mbps camera files). */
  | 'bitrate'
  /** A codec, bit depth or audio format the preview engine can't play. */
  | 'codec';

/** Codecs Chromium decodes reliably on Windows without extra system components. */
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_PIXFMT = new Set(['yuv420p', 'yuvj420p']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
/** Containers Chromium can't open at all, whatever codecs they hold. */
const UNPLAYABLE_CONTAINERS = new Set(['avi']);

const MAX_PREVIEW_LONG_SIDE = 2560;
const MAX_PREVIEW_BITRATE = 40_000_000;

export function proxyReasons(info: MediaInfo): ProxyReason[] {
  const reasons: ProxyReason[] = [];
  if (info.kind === 'image') return reasons;
  if (info.kind === 'audio') {
    if (info.audioCodec && !PLAYABLE_AUDIO.has(info.audioCodec)) reasons.push('codec');
    return reasons;
  }
  if (info.isVFR) reasons.push('vfr');
  if (Math.max(info.width, info.height) > MAX_PREVIEW_LONG_SIDE) reasons.push('resolution');
  if (info.bitRate > MAX_PREVIEW_BITRATE) reasons.push('bitrate');
  const badVideo = !info.videoCodec || !PLAYABLE_VIDEO.has(info.videoCodec) || (info.pixFmt != null && !PLAYABLE_PIXFMT.has(info.pixFmt));
  const badAudio = info.hasAudio && !!info.audioCodec && !PLAYABLE_AUDIO.has(info.audioCodec);
  const badContainer = !!info.container && UNPLAYABLE_CONTAINERS.has(info.container);
  if (badVideo || badAudio || badContainer) reasons.push('codec');
  return reasons;
}

export function needsProxy(info: MediaInfo): boolean {
  return proxyReasons(info).length > 0;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Proxy frame size: short side 720 for heavy footage, otherwise keep up to 1080. */
export function proxySize(info: MediaInfo): { width: number; height: number } {
  const reasons = proxyReasons(info);
  const heavy = reasons.includes('resolution') || reasons.includes('bitrate');
  const shortSide = Math.min(info.width, info.height);
  const limit = Math.min(shortSide, heavy ? 720 : 1080);
  const scale = shortSide > 0 ? limit / shortSide : 1;
  return { width: even(info.width * scale), height: even(info.height * scale) };
}

/** Constant frame rate for the proxy: the nominal rate, snapped to a standard one. */
export function proxyFrameRate(info: MediaInfo): number {
  const candidates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  const base = info.isVFR ? (info.avgFps > 0 && info.avgFps <= 120 ? info.avgFps : info.fps) : info.fps;
  if (!(base > 0) || base > 240) return 30;
  return candidates.reduce((best, c) => (Math.abs(c - base) < Math.abs(best - base) ? c : best), 30);
}

const rateArg = (fps: number) =>
  Math.abs(fps - 23.976) < 0.01 ? '24000/1001' : Math.abs(fps - 29.97) < 0.01 ? '30000/1001' : Math.abs(fps - 59.94) < 0.01 ? '60000/1001' : String(fps);

/** FFmpeg arguments that turn a source file into its editing proxy (.mp4, or .m4a for audio). */
export function proxyArgs(info: MediaInfo, src: string, out: string, encoder: VideoEncoderId, hwDecode = true): string[] {
  const progress = ['-progress', 'pipe:1', '-nostats'];
  if (info.kind === 'audio') {
    return ['-hide_banner', '-y', '-loglevel', 'error', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', ...progress, out];
  }
  const { width, height } = proxySize(info);
  const audio = info.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : [];
  return [
    '-hide_banner', '-y', '-loglevel', 'error',
    ...(hwDecode ? ['-hwaccel', 'auto'] : []),
    '-i', src,
    '-map', '0:v:0',
    ...audio,
    '-vf', `scale=${width}:${height}:flags=bicubic,format=yuv420p`,
    '-fps_mode', 'cfr', '-r', rateArg(proxyFrameRate(info)),
    ...proxyVideoArgs(encoder),
    '-movflags', '+faststart',
    ...progress,
    out,
  ];
}
