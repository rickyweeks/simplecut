import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import {
  PeakAccumulator,
  ffprobeArgs,
  needsProxy,
  parseProbe,
  posterArgs,
  proxyArgs,
  thumbnailArgs,
  thumbnailPlan,
  waveformArgs,
  type MediaInfo,
  type MediaProber,
} from '@simplecut/core';
import { IPC, type AssetEvent, type ThumbnailMeta } from '../shared/api';
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
  await fs.rm(tdir, { recursive: true, force: true });
  await fs.mkdir(tdir, { recursive: true });
  await runFfmpeg(thumbnailArgs(path, join(tdir, '%05d.jpg'), info));
  const count = (await fs.readdir(tdir)).filter((f) => f.endsWith('.jpg')).length;
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
