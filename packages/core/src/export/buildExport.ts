import { joinPath } from '../project/paths';
import { audioTracks, clipEnd, clipsOnTrack, editPoints, isTrackAudible, videoTracks } from '../timeline/query';
import { FORMATS, type Clip, type Frame, type Id, type MediaItem, type ProjectDoc, type Range, type Timeline } from '../types';
import { YOUTUBE_AUDIO_BITRATE, exportVideoArgs, youtubeBitrate, type BitrateSpec, type VideoEncoderId } from './encoders';

/**
 * Export renderer: turns the timeline into FFmpeg jobs.
 *
 * Graph shape (mirrors the preview compositor exactly):
 *   - every video track becomes one stream: its clips and gaps concatenated, each clip
 *     conformed to the timeline frame rate and fitted (letterboxed) into the frame;
 *   - tracks are stacked bottom-up with overlay (V2 covers V1, and so on), on black;
 *   - every audible audio track becomes one 48 kHz stereo stream (clips + silence) and the
 *     tracks are summed with amix (no normalization, same as the Web Audio preview mix).
 * Muted tracks, non-soloed tracks (when anything is soloed) and hidden video tracks are left out.
 *
 * Each clip piece gets its own input with an accurate input seek (-ss before -i), and a
 * linked video+audio pair with the same source range shares one input. Very long edits
 * are split into several passes (chunks) to bound the number of simultaneously open
 * decoders, then joined losslessly.
 */

export interface ExportRequest {
  doc: ProjectDoc;
  /** Timeline frames to export, [start, end). */
  range: Range;
  outputPath: string;
  encoder: VideoEncoderId;
  /** Where temporary files go (filter graph scripts, chunk files). */
  tempDir: string;
  /** Upper bound of FFmpeg inputs per pass before the export is split. */
  maxInputsPerPass?: number;
  /** Decode video inputs on the GPU (-hwaccel auto). */
  hwDecode?: boolean;
  /** Where to read each media item from (defaults to media.path, the original file). */
  resolvePath?: (media: MediaItem) => string;
}

export interface FfmpegJob {
  label: string;
  args: string[];
  /** Output duration, used to turn FFmpeg's out_time into progress. */
  durationSec: number;
}

export interface ExportPlan {
  jobs: FfmpegJob[];
  /** Files to write before running the jobs. */
  files: { path: string; content: string }[];
  /** Files to delete afterwards (including the `files` above and chunk outputs). */
  tempFiles: string[];
  width: number;
  height: number;
  fps: number;
  frames: Frame;
  durationSec: number;
  bitrate: BitrateSpec;
  estimatedBytes: number;
}

export const DEFAULT_MAX_INPUTS_PER_PASS = 40;
const SAMPLE_RATE = 48000;

/** A clip (clipped to the range) or a gap, on one track. */
export interface Piece {
  start: Frame;
  end: Frame;
  clip?: Clip;
}

/** Splits one track into back-to-back pieces that exactly cover the range. */
export function trackPieces(tl: Timeline, trackId: Id, range: Range): Piece[] {
  const out: Piece[] = [];
  let cursor = range.start;
  for (const c of clipsOnTrack(tl, trackId)) {
    const s = Math.max(c.start, range.start);
    const e = Math.min(clipEnd(c), range.end);
    if (e <= s) continue;
    if (s > cursor) out.push({ start: cursor, end: s });
    out.push({ start: s, end: e, clip: c });
    cursor = e;
  }
  if (cursor < range.end) out.push({ start: cursor, end: range.end });
  return out;
}

/** Tracks that contribute to the output inside a range. */
export function exportTracks(tl: Timeline, range: Range): { video: Id[]; audio: Id[] } {
  const hasClips = (id: Id) => clipsOnTrack(tl, id).some((c) => c.start < range.end && clipEnd(c) > range.start);
  return {
    video: videoTracks(tl).filter((t) => !t.hidden && hasClips(t.id)).map((t) => t.id),
    audio: audioTracks(tl).filter((t) => isTrackAudible(tl, t) && hasClips(t.id)).map((t) => t.id),
  };
}

const sec = (s: number) => s.toFixed(6).replace(/\.?0+$/, '') || '0';
const samplesAt = (frame: Frame, fps: number) => Math.round((frame * SAMPLE_RATE) / fps);

class InputTable {
  readonly args: string[][] = [];
  private shared = new Map<string, { index: number; v: boolean; a: boolean }>();

  /** Returns an input index; a linked V+A pair with the same source range shares one input. */
  use(key: string, stream: 'v' | 'a', make: () => string[]): number {
    const entry = this.shared.get(key);
    if (entry && !entry[stream]) {
      entry[stream] = true;
      return entry.index;
    }
    const index = this.args.length;
    this.args.push(make());
    this.shared.set(key, { index, v: stream === 'v', a: stream === 'a' });
    return index;
  }
}

interface Graph {
  inputArgs: string[];
  inputCount: number;
  filter: string;
}

function buildGraph(req: ExportRequest, range: Range): Graph {
  const { doc } = req;
  const tl = doc.timeline;
  const fps = tl.settings.fps;
  const { width: W, height: H } = FORMATS[tl.settings.format];
  const frames = range.end - range.start;
  const totalSamples = samplesAt(range.end, fps) - samplesAt(range.start, fps);
  const resolve = req.resolvePath ?? ((m: MediaItem) => m.path);
  const inputs = new InputTable();
  const chains: string[] = [];
  const tracks = exportTracks(tl, range);

  const inputFor = (piece: Piece, stream: 'v' | 'a'): number => {
    const clip = piece.clip!;
    const media = doc.media[clip.mediaId]!;
    const srcStart = clip.sourceIn + (piece.start - clip.start);
    const len = piece.end - piece.start;
    return inputs.use(`${clip.mediaId}|${srcStart}|${len}`, stream, () => {
      const path = resolve(media);
      if (media.kind === 'image') return ['-loop', '1', '-framerate', String(fps), '-t', sec((len + 1) / fps), '-i', path];
      const seek = srcStart > 0 ? ['-ss', sec(srcStart / fps)] : [];
      const hw = req.hwDecode && media.hasVideo ? ['-hwaccel', 'auto'] : [];
      // A little extra so the decoder never runs dry; the filters trim to the exact length.
      return [...hw, ...seek, '-t', sec((len + 2) / fps), '-i', path];
    });
  };

  // ---- Video ---------------------------------------------------------------
  const trackLabels: string[] = [];
  tracks.video.forEach((trackId, ti) => {
    const pieces = trackPieces(tl, trackId, range);
    // The lowest track can be opaque (cheaper) unless it holds PNGs that may be transparent.
    const opaque = ti === 0 && !pieces.some((p) => p.clip && /\.png$/i.test(doc.media[p.clip.mediaId]?.path ?? ''));
    const labels: string[] = [];
    pieces.forEach((p, pi) => {
      const n = p.end - p.start;
      const label = `v${ti}_${pi}`;
      labels.push(`[${label}]`);
      if (!p.clip) {
        chains.push(
          opaque
            ? `color=c=black:s=${W}x${H}:r=${fps},trim=end_frame=${n},setsar=1,format=yuv420p[${label}]`
            : `color=c=black@0:s=${W}x${H}:r=${fps},format=yuva420p,trim=end_frame=${n},setsar=1[${label}]`,
        );
        return;
      }
      const idx = inputFor(p, 'v');
      const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
      const pad = `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${opaque ? 'black' : 'black@0'}`;
      chains.push(
        `[${idx}:v:0]setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop=-1,trim=end_frame=${n},setpts=PTS-STARTPTS,` +
          `${fit},${opaque ? '' : 'format=yuva420p,'}${pad},setsar=1,format=${opaque ? 'yuv420p' : 'yuva420p'}[${label}]`,
      );
    });
    chains.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[tv${ti}]`);
    trackLabels.push(opaque ? 'opaque' : 'alpha');
  });

  let current: string;
  if (trackLabels.length === 0) {
    chains.push(`color=c=black:s=${W}x${H}:r=${fps},trim=end_frame=${frames},setsar=1,format=yuv420p[vbase]`);
    current = 'vbase';
  } else if (trackLabels[0] === 'opaque') {
    current = 'tv0';
  } else {
    chains.push(`color=c=black:s=${W}x${H}:r=${fps},trim=end_frame=${frames},setsar=1,format=yuv420p[vbase]`);
    chains.push(`[vbase][tv0]overlay=0:0:format=yuv420:eof_action=pass[ov0]`);
    current = 'ov0';
  }
  for (let ti = 1; ti < trackLabels.length; ti++) {
    chains.push(`[${current}][tv${ti}]overlay=0:0:format=yuv420:eof_action=pass[ov${ti}]`);
    current = `ov${ti}`;
  }
  chains.push(`[${current}]format=yuv420p[vout]`);

  // ---- Audio ---------------------------------------------------------------
  const stereo = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
  const audioLabels: string[] = [];
  tracks.audio.forEach((trackId, ti) => {
    const labels: string[] = [];
    trackPieces(tl, trackId, range).forEach((p, pi) => {
      const n = samplesAt(p.end, fps) - samplesAt(p.start, fps);
      const label = `a${ti}_${pi}`;
      labels.push(`[${label}]`);
      if (!p.clip) {
        chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${n},${stereo}[${label}]`);
        return;
      }
      const media = doc.media[p.clip.mediaId]!;
      const idx = inputFor(p, 'a');
      // Mono plays on both speakers at full level, like the Web Audio preview.
      const pan = media.audioChannels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
      chains.push(
        `[${idx}:a:0]asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE},${pan}${stereo},apad,atrim=end_sample=${n},asetpts=PTS-STARTPTS[${label}]`,
      );
    });
    chains.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[ta${ti}]`);
    audioLabels.push(`[ta${ti}]`);
  });
  if (audioLabels.length === 0) {
    chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${totalSamples},${stereo}[aout]`);
  } else if (audioLabels.length === 1) {
    chains.push(`${audioLabels[0]}anull[aout]`);
  } else {
    chains.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0[aout]`);
  }

  return { inputArgs: inputs.args.flat(), inputCount: inputs.args.length, filter: chains.join(';\n') };
}

/** Number of clip pieces (an upper bound on inputs) that a range would need. */
function piecesIn(tl: Timeline, range: Range): number {
  const { video, audio } = exportTracks(tl, range);
  let n = 0;
  for (const id of [...video, ...audio]) n += trackPieces(tl, id, range).filter((p) => p.clip).length;
  return n;
}

/** Splits a long range at edit points so no chunk needs more than `max` inputs. */
export function chunkRanges(tl: Timeline, range: Range, max: number): Range[] {
  if (piecesIn(tl, range) <= max) return [range];
  const points = [...editPoints(tl).filter((p) => p > range.start && p < range.end), range.end];
  const chunks: Range[] = [];
  let start = range.start;
  let best = start;
  for (const p of points) {
    if (piecesIn(tl, { start, end: p }) <= max) {
      best = p;
      continue;
    }
    if (best > start) {
      chunks.push({ start, end: best });
      start = best;
    }
    if (piecesIn(tl, { start, end: p }) <= max) best = p;
    else {
      // Even a single stretch between edit points is too busy: accept it as-is.
      chunks.push({ start, end: p });
      start = best = p;
    }
  }
  if (start < range.end) chunks.push({ start, end: range.end });
  return chunks;
}

const COMMON = ['-hide_banner', '-y', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats'];

export function buildExportPlan(req: ExportRequest): ExportPlan {
  const tl = req.doc.timeline;
  const fps = tl.settings.fps;
  const { width, height } = FORMATS[tl.settings.format];
  const range = { start: Math.max(0, req.range.start), end: req.range.end };
  const frames = range.end - range.start;
  if (frames < 1) throw new Error('Nothing to export: the range is empty.');
  const bitrate = youtubeBitrate(width, height, fps);
  const durationSec = frames / fps;
  const video = [...exportVideoArgs(req.encoder, bitrate, fps), '-r', String(fps), '-fps_mode', 'cfr'];
  const aac = ['-c:a', 'aac', '-b:a', `${YOUTUBE_AUDIO_BITRATE / 1000}k`, '-ar', String(SAMPLE_RATE), '-ac', '2'];
  const files: { path: string; content: string }[] = [];
  const tempFiles: string[] = [];
  const jobs: FfmpegJob[] = [];

  const passArgs = (r: Range, graphPath: string, tail: string[]) => {
    const graph = buildGraph(req, r);
    files.push({ path: graphPath, content: graph.filter });
    tempFiles.push(graphPath);
    return [
      ...COMMON,
      ...graph.inputArgs,
      '-filter_complex_script', graphPath,
      '-map', '[vout]', '-map', '[aout]',
      '-frames:v', String(r.end - r.start),
      ...tail,
    ];
  };

  const chunks = chunkRanges(tl, range, req.maxInputsPerPass ?? DEFAULT_MAX_INPUTS_PER_PASS);
  if (chunks.length === 1) {
    jobs.push({
      label: 'Exporting',
      args: passArgs(range, joinPath(req.tempDir, 'scut-graph.txt'), [...video, ...aac, '-movflags', '+faststart', req.outputPath]),
      durationSec,
    });
  } else {
    // Each chunk: final video codec + lossless float PCM audio (so no AAC seams), then one
    // stream-copy join that encodes the audio once.
    const listLines = ['ffconcat version 1.0'];
    chunks.forEach((r, i) => {
      const name = `scut-part-${String(i).padStart(3, '0')}.mkv`;
      const out = joinPath(req.tempDir, name);
      tempFiles.push(out);
      listLines.push(`file '${name}'`);
      jobs.push({
        label: `Exporting part ${i + 1} of ${chunks.length}`,
        args: passArgs(r, joinPath(req.tempDir, `scut-graph-${i}.txt`), [...video, '-c:a', 'pcm_f32le', out]),
        durationSec: (r.end - r.start) / fps,
      });
    });
    const listPath = joinPath(req.tempDir, 'scut-parts.ffconcat');
    files.push({ path: listPath, content: listLines.join('\n') + '\n' });
    tempFiles.push(listPath);
    jobs.push({
      label: 'Finishing',
      args: [...COMMON, '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', ...aac, '-movflags', '+faststart', req.outputPath],
      durationSec,
    });
  }

  return {
    jobs,
    files,
    tempFiles,
    width,
    height,
    fps,
    frames,
    durationSec,
    bitrate,
    estimatedBytes: Math.round(((bitrate.target + YOUTUBE_AUDIO_BITRATE) * durationSec) / 8),
  };
}
