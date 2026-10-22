import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import {
  PeakAccumulator,
  beatAnalysisArgs,
  denoiseArgs,
  denoiseStep,
  expectedThumbnailCount,
  ffprobeArgs,
  needsProxy,
  parseCube,
  parseProbe,
  parseSilenceDetect,
  reverseJobs,
  silenceDetectArgs,
  posterArgs,
  proxyArgs,
  thumbnailArgs,
  thumbnailPlan,
  waveformArgs,
  type BeatAnalysis,
  type CubeLut,
  type MediaInfo,
  type MediaItem,
  type SilenceSettings,
  type MediaProber,
} from '@simplecut/core';
import { IPC, type AssetEvent, type ThumbnailMeta } from '../shared/api';
import createBeatWorker from './beatWorker?nodeWorker';
import { encoderDetector } from './encoders';
import { runFfmpeg, runFfprobe } from './ffmpeg';

export const prober: MediaProber = {
  async probe(path) {
    const stat = await fs.stat(path);
    const json = await runFfprobe(ffprobeArgs(path), { timeoutMs: 60_000 });
    return parseProbe(JSON.parse(json), path, stat.size);
  },
};

// ---------------------------------------------------------------------------
// Cache: one folder per source file version (path + size + mtime), so edits to a
// file invalidate its proxies, and re-opening a project is instant.
// ---------------------------------------------------------------------------

function cacheRoot(): string {
  return join(app.getPath('userData'), 'media-cache');
}

async function cacheDirFor(path: string): Promise<string> {
  const st = await fs.stat(path);
  const key = createHash('sha1').update(`${path.toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  const dir = join(cacheRoot(), key);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

function broadcast(e: AssetEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.mediaAsset, e);
}

// ---------------------------------------------------------------------------
// Work queue: light jobs (posters, waveforms, thumbnails) run two at a time; proxies,
// which are heavy encodes, run one at a time so the editor stays responsive.
// ---------------------------------------------------------------------------

class Lane {
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  constructor(private readonly concurrency: number) {}
  push(task: () => Promise<void>): void {
    this.queue.push(task);
    this.pump();
  }
  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift()!;
      this.active++;
      task().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

const light = new Lane(2);
const heavy = new Lane(1);
const inflight = new Map<string, Promise<void>>();

type Kind = AssetEvent['kind'];

function schedule(path: string, dir: string, kind: Kind, lane: Lane, work: (emit: (e: Partial<AssetEvent>) => void) => Promise<Partial<AssetEvent>>): void {
  const key = `${dir}:${kind}`;
  if (inflight.has(key)) return;
  const emit = (e: Partial<AssetEvent>) => broadcast({ path, kind, state: 'running', ...e });
  const p = new Promise<void>((resolve) => {
    emit({ state: 'queued' });
    lane.push(async () => {
      try {
        emit({ state: 'running', progress: 0 });
        const done = await work(emit);
        emit({ state: 'ready', progress: 1, ...done });
      } catch (err) {
        emit({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
      } finally {
        inflight.delete(key);
        resolve();
      }
    });
  });
  inflight.set(key, p);
}

async function makePoster(path: string, dir: string, info: MediaInfo): Promise<Partial<AssetEvent>> {
  const out = join(dir, 'poster.jpg');
  if (!(await exists(out))) await runFfmpeg(posterArgs(path, out, info), { timeoutMs: 60_000 });
  return { output: out };
}

async function makeWaveform(path: string, dir: string): Promise<Partial<AssetEvent>> {
  const out = join(dir, 'waveform.bin');
  if (await exists(out)) return { output: out };
  const acc = new PeakAccumulator();
  let leftover = Buffer.alloc(0);
  await runFfmpeg(waveformArgs(path), {
    onStdout: (chunk) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      // Copy into an aligned buffer: Node chunks are not guaranteed 4-byte aligned.
      acc.push(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable)));
      leftover = Buffer.from(buf.subarray(usable));
    },
  });
  await fs.writeFile(out, acc.result());
  return { output: out };
}

async function makeThumbnails(path: string, dir: string, info: MediaInfo): Promise<Partial<AssetEvent>> {
  const tdir = join(dir, 'thumbs');
  const metaFile = join(tdir, 'meta.json');
  if (await exists(metaFile)) return { output: tdir, thumbs: JSON.parse(await fs.readFile(metaFile, 'utf8')) as ThumbnailMeta };
  const countJpegs = async () => (await fs.readdir(tdir)).filter((f) => f.endsWith('.jpg')).length;
  await fs.rm(tdir, { recursive: true, force: true });
  await fs.mkdir(tdir, { recursive: true });
  await runFfmpeg(thumbnailArgs(path, join(tdir, '%05d.jpg'), info, { keyframesOnly: true }));
  let count = await countJpegs();
  if (count < expectedThumbnailCount(info) / 2) {
    // Too few keyframes in this file: decode every frame instead (slower, always complete).
    await fs.rm(tdir, { recursive: true, force: true });
    await fs.mkdir(tdir, { recursive: true });
    await runFfmpeg(thumbnailArgs(path, join(tdir, '%05d.jpg'), info, { keyframesOnly: false }));
    count = await countJpegs();
  }
  const plan = thumbnailPlan(info);
  const meta: ThumbnailMeta = { intervalSec: plan.intervalSec, height: plan.height, count };
  await fs.writeFile(metaFile, JSON.stringify(meta));
  return { output: tdir, thumbs: meta };
}

async function makeProxy(path: string, dir: string, info: MediaInfo, emit: (e: Partial<AssetEvent>) => void): Promise<Partial<AssetEvent>> {
  const ext = info.kind === 'audio' ? '.m4a' : '.mp4';
  const out = join(dir, `proxy${ext}`);
  if (await exists(out)) return { output: out };
  const tmp = join(dir, `proxy.part${ext}`);
  const encoders = await encoderDetector.detect();
  let lastEmit = 0;
  const attempt = (encoder: Parameters<typeof proxyArgs>[3], hwDecode: boolean) =>
    runFfmpeg(proxyArgs(info, path, tmp, encoder, hwDecode), {
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastEmit < 250 || !(info.durationSec > 0)) return;
        lastEmit = now;
        emit({ progress: Math.min(0.99, p.outTimeSec / info.durationSec) });
      },
    });
  try {
    await attempt(encoders[0] ?? 'libx264', true);
  } catch (err) {
    // GPU encode or decode failed on this file: fall back to software.
    if (!encoders.length) throw err;
    await attempt('libx264', false);
  }
  await fs.rename(tmp, out);
  return { output: out };
}

// ---------------------------------------------------------------------------
// Beats (for the music track) and noise reduction, both cached per file.
// ---------------------------------------------------------------------------

const beatJobs = new Map<string, Promise<BeatAnalysis>>();

/** Decodes the audio at 11 kHz mono and runs beat detection in a worker thread. */
export function analyzeBeatsFor(path: string): Promise<BeatAnalysis> {
  let job = beatJobs.get(path);
  if (job) return job;
  job = (async () => {
    const dir = await cacheDirFor(path);
    const cached = join(dir, 'beats.json');
    if (await exists(cached)) return JSON.parse(await fs.readFile(cached, 'utf8')) as BeatAnalysis;
    const chunks: Buffer[] = [];
    await runFfmpeg(beatAnalysisArgs(path), { onStdout: (c) => chunks.push(c) });
    const buf = Buffer.concat(chunks);
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
    const result = await new Promise<BeatAnalysis>((resolve, reject) => {
      const worker = createBeatWorker({ workerData: { samples }, transferList: [samples.buffer as ArrayBuffer] });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => code !== 0 && reject(new Error(`Beat analysis stopped (code ${code}).`)));
    });
    await fs.writeFile(cached, JSON.stringify(result));
    return result;
  })().finally(() => beatJobs.delete(path));
  beatJobs.set(path, job);
  return job;
}

const denoiseJobs = new Map<string, Promise<string>>();

/**
 * The file's audio with background noise reduced at a given strength. The preview plays
 * this file and the export reads it, so both sound the same.
 */
export function denoisedAudio(path: string, info: MediaInfo, strength: number): Promise<string> {
  const step = denoiseStep(strength);
  const key = `${path}|${step}`;
  let job = denoiseJobs.get(key);
  if (job) return job;
  const variant = String(step);
  const emit = (e: Partial<AssetEvent>) => broadcast({ path, kind: 'denoise', variant, state: 'running', ...e });
  job = (async () => {
    const dir = await cacheDirFor(path);
    const out = join(dir, `denoise-${Math.round(step * 10)}.flac`);
    if (await exists(out)) {
      emit({ state: 'ready', progress: 1, output: out });
      return out;
    }
    const tmp = join(dir, `denoise-${Math.round(step * 10)}.part.flac`);
    emit({ state: 'running', progress: 0 });
    let last = 0;
    try {
      await runFfmpeg(denoiseArgs(path, tmp, step), {
        onProgress: (p) => {
          if (Date.now() - last < 250 || !(info.durationSec > 0)) return;
          last = Date.now();
          emit({ progress: Math.min(0.99, p.outTimeSec / info.durationSec) });
        },
      });
      await fs.rename(tmp, out);
    } catch (err) {
      emit({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    emit({ state: 'ready', progress: 1, output: out });
    return out;
  })().finally(() => denoiseJobs.delete(key));
  denoiseJobs.set(key, job);
  return job;
}

/** Starts (or reuses cached) background work for one media file. */
export async function prepareMedia(path: string, info: MediaInfo, opts: { forceProxy?: boolean } = {}): Promise<void> {
  const dir = await cacheDirFor(path);
  if (info.hasVideo) schedule(path, dir, 'poster', light, () => makePoster(path, dir, info));
  if (info.hasAudio) schedule(path, dir, 'waveform', light, () => makeWaveform(path, dir));
  if (info.kind === 'video') schedule(path, dir, 'thumbnails', light, () => makeThumbnails(path, dir, info));
  if (info.kind !== 'image' && (opts.forceProxy || needsProxy(info))) {
    schedule(path, dir, 'proxy', heavy, (emit) => makeProxy(path, dir, info, emit));
  }
}

// ---------------------------------------------------------------------------
// Reverse, silence detection, Auto Color samples and LUT files
// ---------------------------------------------------------------------------

const reverseJobsInflight = new Map<string, Promise<string>>();

/** A reversed copy of [inSec, outSec) of a file, made in chunks and cached next to its other assets. */
export function reverseMedia(media: MediaItem, inSec: number, outSec: number): Promise<string> {
  const key = `${media.path}|${inSec.toFixed(3)}|${outSec.toFixed(3)}`;
  let job = reverseJobsInflight.get(key);
  if (job) return job;
  job = (async () => {
    const dir = await cacheDirFor(media.path);
    const out = join(dir, `reverse-${Math.round(inSec * 1000)}-${Math.round(outSec * 1000)}.mp4`);
    if (await exists(out)) return out;
    const temp = await fs.mkdtemp(join(dir, 'rev-'));
    try {
      const part = join(temp, 'reversed.mp4');
      const { jobs, listPath, listText } = reverseJobs(media, inSec, outSec, temp, part);
      await fs.writeFile(listPath, listText);
      for (const j of jobs) await runFfmpeg(j.args);
      await fs.rename(part, out);
      return out;
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  })().finally(() => reverseJobsInflight.delete(key));
  reverseJobsInflight.set(key, job);
  return job;
}

/** Pauses in part of a file's audio (silencedetect). */
export async function detectSilences(path: string, startSec: number, durationSec: number, settings: SilenceSettings): Promise<{ start: number; end: number }[]> {
  let log = '';
  await runFfmpeg(silenceDetectArgs(path, startSec, durationSec, settings), {
    onStderr: (t) => {
      log += t;
    },
  });
  return parseSilenceDetect(log, durationSec);
}

/** 64x36 RGB samples of the picture at each time (BT.709, as the preview shows it). */
export async function colorSamples(path: string, times: number[]): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (const t of times) {
    const chunks: Buffer[] = [];
    await runFfmpeg(
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', Math.max(0, t).toFixed(3), '-i', path, '-frames:v', '1',
        '-vf', 'scale=64:36:in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24', '-f', 'rawvideo', 'pipe:1'],
      { onStdout: (c) => chunks.push(c), timeoutMs: 30_000 },
    );
    parts.push(Buffer.concat(chunks));
  }
  return new Uint8Array(Buffer.concat(parts));
}

const lutCache = new Map<string, { mtime: number; lut: CubeLut }>();

/** Reads and parses a .cube file (cached until the file changes). */
export async function readLut(path: string): Promise<CubeLut> {
  const st = await fs.stat(path);
  const hit = lutCache.get(path);
  if (hit && hit.mtime === st.mtimeMs) return hit.lut;
  if (st.size > 64 * 1024 * 1024) throw new Error('This LUT file is too large.');
  const lut = parseCube(await fs.readFile(path, 'utf8'));
  lutCache.set(path, { mtime: st.mtimeMs, lut });
  return lut;
}
