import type { MediaInfo, MediaKind } from '../types';
import { extname } from '../project/paths';

export const IMPORT_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.png', '.jpg', '.jpeg'];
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const IMAGE_FORMATS = new Set(['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe']);

export function isImportable(path: string): boolean {
  return IMPORT_EXTENSIONS.includes(extname(path));
}

/** ffprobe arguments that produce the JSON parseProbe expects. */
export function ffprobeArgs(path: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path];
}

/** Parses "30000/1001" or "29.97". Returns 0 for "0/0" and garbage. */
export function parseRate(r: unknown): number {
  if (typeof r === 'number') return Number.isFinite(r) ? r : 0;
  if (typeof r !== 'string') return 0;
  const [a, b] = r.split('/');
  const n = Number(a);
  const d = b === undefined ? 1 : Number(b);
  return d > 0 && Number.isFinite(n) ? n / d : 0;
}

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const toNum = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

function rotationOf(stream: Json): number {
  const tags = asObj(stream.tags);
  let deg: number | null = null;
  if (tags.rotate !== undefined) deg = toNum(tags.rotate);
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list.map(asObj) : [];
  const matrix = side.find((s) => s.side_data_type === 'Display Matrix' && s.rotation !== undefined);
  // Display-matrix rotation is counter-clockwise; we store clockwise.
  if (deg === null && matrix) deg = -toNum(matrix.rotation);
  const r = Math.round((deg ?? 0) / 90) * 90;
  return ((r % 360) + 360) % 360;
}

/**
 * Variable frame rate heuristic: nominal and average rates disagree. CFR files match
 * almost exactly; phone footage typically drifts by a fraction of a percent or reports a
 * timebase-like nominal rate (e.g. 90000/1).
 */
export function detectVFR(nominal: number, average: number): boolean {
  if (!(nominal > 0) || !(average > 0)) return false;
  if (nominal > 2 * average || nominal > 240) return true;
  return Math.abs(nominal - average) / nominal > 0.001;
}

/** Turns ffprobe JSON into MediaInfo. */
export function parseProbe(json: unknown, path: string, fileSize = 0): MediaInfo {
  const root = asObj(json);
  const format = asObj(root.format);
  const streams = (Array.isArray(root.streams) ? root.streams : []).map(asObj);
  const v = streams.find((s) => s.codec_type === 'video' && toNum(asObj(s.disposition).attached_pic) !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error('This file has no video or audio that SimpleCut can read.');

  const formatName = String(format.format_name ?? '');
  const isImage = !!v && (IMAGE_EXTENSIONS.has(extname(path)) || IMAGE_FORMATS.has(formatName));
  const kind: MediaKind = isImage ? 'image' : v ? 'video' : 'audio';

  const rotation = v ? rotationOf(v) : 0;
  let width = v ? toNum(v.width) : 0;
  let height = v ? toNum(v.height) : 0;
  if (rotation % 180 === 90) [width, height] = [height, width];

  const fps = v && !isImage ? parseRate(v.r_frame_rate) : 0;
  const avgFps = v && !isImage ? parseRate(v.avg_frame_rate) : 0;
  const duration = isImage ? 0 : toNum(format.duration) || toNum(v?.duration) || toNum(a?.duration);

  return {
    kind,
    durationSec: duration,
    hasVideo: !!v,
    hasAudio: !!a && !isImage,
    width,
    height,
    fps: fps || avgFps,
    avgFps: avgFps || fps,
    isVFR: kind === 'video' && detectVFR(fps, avgFps),
    videoCodec: v ? String(v.codec_name ?? '') || null : null,
    audioCodec: a ? String(a.codec_name ?? '') || null : null,
    pixFmt: v ? String(v.pix_fmt ?? '') || null : null,
    bitRate: toNum(format.bit_rate) || toNum(v?.bit_rate),
    audioChannels: a ? toNum(a.channels) : 0,
    audioSampleRate: a ? toNum(a.sample_rate) : 0,
    rotation,
    fileSize: fileSize || toNum(format.size),
  };
}
