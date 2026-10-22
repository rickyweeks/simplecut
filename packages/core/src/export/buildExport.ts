import { DEFAULT_DUCK_DB, duckVolumeFilters, effectiveFades, type DuckRegion } from '../audio/mix';
import { joinPath } from '../project/paths';
import { textAnimationFilters } from '../text/text';
import { audioTracks, clipEnd, clipsOnTrack, editPoints, getTrack, isTrackAudible, videoTracks } from '../timeline/query';
import { isOverlapping, trackTransitions, transitionSpan } from '../timeline/transitions';
import { FORMATS, type Clip, type Frame, type Id, type MediaItem, type ProjectDoc, type Range, type Timeline } from '../types';
import { YOUTUBE_AUDIO_BITRATE, exportVideoArgs, youtubeBitrate, type BitrateSpec, type VideoEncoderId } from './encoders';

/**
 * Export renderer: turns the timeline into FFmpeg jobs.
 *
 * Graph shape (mirrors the preview compositor exactly):
 *   - every video track becomes one stream: its clips and gaps concatenated, each clip
 *     conformed to the timeline frame rate and fitted (letterboxed) into the frame;
 *     dissolves/slides join neighbouring clips with xfade (using media handles), dips and
 *     fade-ins/outs use fade; titles are transparent full-frame images with their animation;
 *   - tracks are stacked bottom-up with overlay (V2 covers V1, and so on), on black;
 *   - every audible audio track becomes one 48 kHz stereo stream: clips (volume, fades,
 *     optional noise-reduced source) joined by silence or constant-power crossfades, then
 *     track volume and, on the music track, ducking under dialogue; tracks are summed with
 *     amix (no normalization, like the preview) and the master gain applied.
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
  /** Audio source for a clip (e.g. its noise-reduced version). Defaults to the media file. */
  audioPathFor?: (clip: Clip, media: MediaItem) => string;
  /** Transparent full-frame PNG per title clip, rendered by the app. */
  textImages?: Record<Id, string>;
  /** Where dialogue is (timeline seconds); the music track ducks under it. */
  duckRegions?: DuckRegion[];
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

// ---------------------------------------------------------------------------
// Per-track segments: pieces plus what transitions do to them
// ---------------------------------------------------------------------------

type FadeColor = 'black' | 'white' | 'alpha';

interface Fade {
  dir: 'in' | 'out';
  /** Frame offset from the start of the visible piece. */
  at: Frame;
  frames: Frame;
  color: FadeColor;
}

interface Segment extends Piece {
  /** Extra source frames before / after the visible piece (transition handles). */
  before: Frame;
  after: Frame;
  fades: Fade[];
  /** Overlapping transition with the previous segment (xfade / acrossfade). */
  join?: { type: 'dissolve' | 'slide' | 'crossfade'; frames: Frame };
}

function trackSegments(tl: Timeline, trackId: Id, range: Range): Segment[] {
  const segs: Segment[] = trackPieces(tl, trackId, range).map((p) => ({ ...p, before: 0, after: 0, fades: [] }));
  const byClip = new Map(segs.filter((s) => s.clip).map((s) => [s.clip!.id, s]));
  const colorOf = (type: string): FadeColor => (type === 'dipBlack' ? 'black' : type === 'dipWhite' ? 'white' : 'alpha');
  for (const t of trackTransitions(tl, trackId)) {
    const span = transitionSpan(t);
    // Transitions cut by the export range are left out (hard cut there).
    if (span.start < range.start || span.end > range.end) continue;
    if (t.kind === 'cut') {
      const a = byClip.get(t.a.id);
      const b = byClip.get(t.b.id);
      if (!a || !b) continue;
      if (isOverlapping(t.type)) {
        a.after += t.h1;
        b.before += t.h2;
        b.join = { type: t.type as 'dissolve' | 'slide' | 'crossfade', frames: t.duration };
      } else {
        a.fades.push({ dir: 'out', at: a.end - a.start - t.h2, frames: t.h2, color: colorOf(t.type) });
        b.fades.push({ dir: 'in', at: 0, frames: t.h1, color: colorOf(t.type) });
      }
    } else {
      const s = byClip.get(t.clip.id);
      if (!s) continue;
      if (t.kind === 'in') s.fades.push({ dir: 'in', at: span.start - s.start, frames: t.duration, color: colorOf(t.type) });
      else s.fades.push({ dir: 'out', at: span.start - s.start, frames: t.duration, color: colorOf(t.type) });
    }
  }
  return segs;
}

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

function buildGraph(req: ExportRequest, range: Range, opts: { video: boolean; masterGain: boolean }): Graph {
  const { doc } = req;
  const tl = doc.timeline;
  const fps = tl.settings.fps;
  const { width: W, height: H } = FORMATS[tl.settings.format];
  const frames = range.end - range.start;
  const totalSamples = samplesAt(range.end, fps) - samplesAt(range.start, fps);
  const resolve = req.resolvePath ?? ((m: MediaItem) => m.path);
  const audioPath = req.audioPathFor ?? ((_c: Clip, m: MediaItem) => resolve(m));
  const inputs = new InputTable();
  const chains: string[] = [];
  const tracks = exportTracks(tl, range);

  /** Input for a segment; returns the index and how many frames of padding precede the source. */
  const inputFor = (seg: Segment, stream: 'v' | 'a'): { index: number; padStart: Frame } => {
    const clip = seg.clip!;
    const media = doc.media[clip.mediaId]!;
    const wanted = clip.sourceIn + (seg.start - clip.start) - seg.before;
    const srcStart = Math.max(0, wanted);
    const padStart = srcStart - wanted;
    const len = seg.end - seg.start + seg.before + seg.after - padStart;
    const path = stream === 'a' ? audioPath(clip, media) : resolve(media);
    const index = inputs.use(`${path}|${srcStart}|${len}`, stream, () => {
      if (media.kind === 'image') return ['-loop', '1', '-framerate', String(fps), '-t', sec((len + 1) / fps), '-i', path];
      const seek = srcStart > 0 ? ['-ss', sec(srcStart / fps)] : [];
      const hw = stream === 'v' && req.hwDecode && media.hasVideo ? ['-hwaccel', 'auto'] : [];
      // A little extra so the decoder never runs dry; the filters trim to the exact length.
      return [...hw, ...seek, '-t', sec((len + 2) / fps), '-i', path];
    });
    return { index, padStart };
  };

  // ---- Video ---------------------------------------------------------------
  const trackLabels: ('opaque' | 'alpha')[] = [];
  if (opts.video) {
    tracks.video.forEach((trackId, ti) => {
      const segs = trackSegments(tl, trackId, range);
      // The lowest track can be opaque (cheaper) unless it holds titles or PNGs that may be transparent.
      const opaque =
        ti === 0 && !segs.some((s) => s.clip && (s.clip.text || /\.png$/i.test(doc.media[s.clip.mediaId]?.path ?? '')));
      // Fades to a color are a solid layer whose alpha ramps, overlaid in YUV: exactly the
      // preview's "color drawn over the clip at 1 − factor". (The fade filter can't be used:
      // it only stays in YUV for full-range black, and converts through RGB otherwise.)
      // Colors are TV-range black/white, what the preview's RGB black/white encode to.
      const tv = { black: '0x101010', white: '0xEBEBEB' } as const;
      const applyFades = (raw: string, label: string, fadesIn: Fade[], offset: Frame) => {
        let current = raw;
        const inline: string[] = [];
        fadesIn.forEach((f, k) => {
          const color = f.color === 'alpha' && opaque ? 'black' : f.color;
          if (color === 'alpha') {
            inline.push(`fade=t=${f.dir}:s=${offset + f.at}:n=${f.frames}:alpha=1`);
            return;
          }
          const layer = `${label}c${k}`;
          // Fading the clip out = fading the color layer in, and vice versa.
          chains.push(
            `color=c=${tv[color]}:s=${W}x${H}:r=${fps},format=yuva420p,trim=end_frame=${f.frames},` +
              `fade=t=${f.dir === 'out' ? 'in' : 'out'}:s=0:n=${f.frames}:alpha=1,setpts=PTS+${sec((offset + f.at) / fps)}/TB[${layer}]`,
          );
          chains.push(`[${current}][${layer}]overlay=0:0:format=yuv420:eof_action=pass[${layer}o]`);
          current = `${layer}o`;
        });
        chains.push(`[${current}]${inline.length ? inline.join(',') : 'null'}[${label}]`);
      };
      const groups: string[] = [];
      let cur: { label: string; frames: Frame } | null = null;
      segs.forEach((seg, si) => {
        const label = `v${ti}_${si}`;
        const n = seg.end - seg.start + seg.before + seg.after;
        if (!seg.clip) {
          if (cur) groups.push(`[${cur.label}]`);
          cur = null;
          chains.push(
            opaque
              ? `color=c=black:s=${W}x${H}:r=${fps},trim=end_frame=${n},setsar=1,format=yuv420p[${label}]`
              : `color=c=black@0:s=${W}x${H}:r=${fps},format=yuva420p,trim=end_frame=${n},setsar=1[${label}]`,
          );
          groups.push(`[${label}]`);
          return;
        }
        // Without fades the chain ends in the segment's label directly.
        const rawLabel = seg.fades.length ? `${label}r` : label;
        if (seg.clip.text) {
          const png = req.textImages?.[seg.clip.id];
          if (!png) throw new Error('A title has not been rendered for export.');
          // Animations run on clip time: render from the clip's first frame, drop what the export
          // range cuts off, and hold the first frame for any transition handle before it.
          const into = seg.start - seg.clip.start;
          const total = into + (seg.end - seg.start) + seg.after;
          const idx = inputs.use(`text|${seg.clip.id}|${total}`, 'v', () => ['-loop', '1', '-framerate', String(fps), '-t', sec((total + 1) / fps), '-i', png]);
          const anim = textAnimationFilters(seg.clip.text, seg.clip.duration, fps, W, H);
          const parts = [`fps=${fps}`, `trim=end_frame=${total}`, 'setpts=PTS-STARTPTS', 'format=yuva420p', ...anim];
          if (into > 0) parts.push(`trim=start_frame=${into}`, 'setpts=PTS-STARTPTS');
          if (seg.before > 0) parts.push(`tpad=start_mode=clone:start=${seg.before}`);
          parts.push('setsar=1');
          chains.push(`[${idx}:v:0]${parts.join(',')}[${rawLabel}]`);
        } else {
          const { index, padStart } = inputFor(seg, 'v');
          const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
          const pad = `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${opaque ? 'black' : 'black@0'}`;
          const head = padStart > 0 ? `tpad=start_mode=clone:start=${padStart},` : '';
          chains.push(
            `[${index}:v:0]setpts=PTS-STARTPTS,fps=${fps},${head}tpad=stop_mode=clone:stop=-1,trim=end_frame=${n},setpts=PTS-STARTPTS,` +
              `${fit},${opaque ? '' : 'format=yuva420p,'}${pad},setsar=1,format=${opaque ? 'yuv420p' : 'yuva420p'}[${rawLabel}]`,
          );
        }
        if (seg.fades.length) applyFades(rawLabel, label, seg.fades, seg.before);
        if (seg.join && cur) {
          const merged = `${label}m`;
          const transition = seg.join.type === 'slide' ? 'slideleft' : 'fade';
          chains.push(`[${cur.label}][${label}]xfade=transition=${transition}:duration=${sec(seg.join.frames / fps)}:offset=${sec((cur.frames - seg.join.frames) / fps)}[${merged}]`);
          cur = { label: merged, frames: cur.frames + n - seg.join.frames };
        } else {
          if (cur) groups.push(`[${cur.label}]`);
          cur = { label, frames: n };
        }
      });
      if (cur) groups.push(`[${(cur as { label: string }).label}]`);
      chains.push(`${groups.join('')}concat=n=${groups.length}:v=1:a=0[tv${ti}]`);
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
  }

  // ---- Audio ---------------------------------------------------------------
  const stereo = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
  const audioLabels: string[] = [];
  tracks.audio.forEach((trackId, ti) => {
    const track = getTrack(tl, trackId)!;
    const segs = trackSegments(tl, trackId, range);
    const groups: string[] = [];
    let cur: { label: string; samples: number } | null = null;
    segs.forEach((seg, si) => {
      const label = `a${ti}_${si}`;
      const n = samplesAt(seg.end + seg.after, fps) - samplesAt(seg.start - seg.before, fps);
      if (!seg.clip) {
        if (cur) groups.push(`[${cur.label}]`);
        cur = null;
        chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${n},${stereo}[${label}]`);
        groups.push(`[${label}]`);
        return;
      }
      const clip = seg.clip;
      const media = doc.media[clip.mediaId]!;
      const { index, padStart } = inputFor(seg, 'a');
      // Mono plays on both speakers at full level, like the Web Audio preview.
      const pan = media.audioChannels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
      const fx: string[] = [];
      if (padStart > 0) fx.push(`adelay=delays=${samplesAt(padStart, fps)}S:all=1`);
      fx.push(`apad`, `atrim=end_sample=${n}`, `asetpts=PTS-STARTPTS`);
      if (clip.volumeDb) fx.push(`volume=${clip.volumeDb.toFixed(2)}dB`);
      // Clip fades (linear, like afade's default curve), placed relative to this segment.
      const segStartSample = samplesAt(seg.start - seg.before, fps);
      const { fadeIn, fadeOut } = effectiveFades(clip);
      const inStart = samplesAt(clip.start, fps) - segStartSample;
      if (fadeIn > 0 && inStart >= 0) fx.push(`afade=t=in:ss=${inStart}:ns=${samplesAt(clip.start + fadeIn, fps) - samplesAt(clip.start, fps)}`);
      const outStart = samplesAt(clipEnd(clip) - fadeOut, fps) - segStartSample;
      if (fadeOut > 0 && samplesAt(clipEnd(clip), fps) <= samplesAt(seg.end + seg.after, fps)) {
        fx.push(`afade=t=out:ss=${outStart}:ns=${samplesAt(clipEnd(clip), fps) - samplesAt(clipEnd(clip) - fadeOut, fps)}`);
      }
      // One-sided audio transitions are fades too.
      for (const f of seg.fades) {
        const ss = samplesAt(seg.start + f.at, fps) - segStartSample;
        const ns = samplesAt(seg.start + f.at + f.frames, fps) - samplesAt(seg.start + f.at, fps);
        fx.push(`afade=t=${f.dir}:ss=${ss}:ns=${ns}`);
      }
      chains.push(`[${index}:a:0]asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE},${pan}${stereo},${fx.join(',')}[${label}]`);
      if (seg.join && cur) {
        const merged = `${label}m`;
        const ns = samplesAt(seg.start + seg.join.frames - seg.before, fps) - samplesAt(seg.start - seg.before, fps);
        chains.push(`[${cur.label}][${label}]acrossfade=ns=${ns}:c1=qsin:c2=qsin[${merged}]`);
        cur = { label: merged, samples: cur.samples + n - ns };
      } else {
        if (cur) groups.push(`[${cur.label}]`);
        cur = { label, samples: n };
      }
    });
    if (cur) groups.push(`[${(cur as { label: string }).label}]`);
    const post: string[] = [];
    if (track.volumeDb) post.push(`volume=${track.volumeDb.toFixed(2)}dB`);
    const depth = tl.duckDb ?? DEFAULT_DUCK_DB;
    if (track.music && depth < 0 && req.duckRegions?.length) {
      post.push(...duckVolumeFilters(req.duckRegions, depth, range.start / fps, frames / fps));
    }
    chains.push(`${groups.join('')}concat=n=${groups.length}:v=0:a=1${post.length ? `,${post.join(',')}` : ''}[ta${ti}]`);
    audioLabels.push(`[ta${ti}]`);
  });
  const master = opts.masterGain && tl.masterGainDb ? `,volume=${tl.masterGainDb.toFixed(2)}dB` : '';
  if (audioLabels.length === 0) {
    chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${totalSamples},${stereo}[aout]`);
  } else if (audioLabels.length === 1) {
    chains.push(`${audioLabels[0]}anull${master}[aout]`);
  } else {
    chains.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0${master}[aout]`);
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

/**
 * Splits a long range at edit points so no chunk needs more than `max` inputs. Never splits
 * inside a transition (both sides of it must be rendered together).
 */
export function chunkRanges(tl: Timeline, range: Range, max: number): Range[] {
  if (piecesIn(tl, range) <= max) return [range];
  const spans = tl.tracks.flatMap((t) => trackTransitions(tl, t.id).map(transitionSpan));
  const points = [...editPoints(tl).filter((p) => p > range.start && p < range.end && spans.every((s) => p <= s.start || p >= s.end)), range.end];
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
    const graph = buildGraph(req, r, { video: true, masterGain: true });
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

/**
 * Measures the mix's loudness (before master gain) with FFmpeg's loudnorm analysis pass.
 * Output goes to the null muxer; the measurement is printed as JSON on stderr.
 */
export function buildLoudnessJob(req: Omit<ExportRequest, 'outputPath' | 'encoder'>): { job: FfmpegJob; files: { path: string; content: string }[] } {
  const fps = req.doc.timeline.settings.fps;
  const range = { start: Math.max(0, req.range.start), end: req.range.end };
  const graph = buildGraph({ ...req, outputPath: '', encoder: 'libx264' }, range, { video: false, masterGain: false });
  const graphPath = joinPath(req.tempDir, 'scut-loudness.txt');
  const filter = `${graph.filter};\n[aout]loudnorm=I=-14:TP=-1:LRA=11:print_format=json[an]`;
  return {
    job: {
      label: 'Measuring loudness',
      args: ['-hide_banner', '-y', '-loglevel', 'info', '-nostdin', '-progress', 'pipe:1', '-nostats', ...graph.inputArgs, '-filter_complex_script', graphPath, '-map', '[an]', '-f', 'null', '-'],
      durationSec: (range.end - range.start) / fps,
    },
    files: [{ path: graphPath, content: filter }],
  };
}
