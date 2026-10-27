/**
 * AVI files from old cameras, screen recorders and DVD rips: they import, get an editing
 * proxy (Chromium can't open AVI), and export frame-accurately from the original.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildExportPlan,
  createTimeline,
  ffprobeArgs,
  isImportable,
  parseProbe,
  proxyArgs,
  proxyReasons,
  sequentialIds,
  type Clip,
  type MediaItem,
  type ProjectDoc,
} from '@simplecut/core';

const bin = join(__dirname, '..', 'resources', 'bin');
const ffmpeg = join(bin, 'ffmpeg.exe');
const ffprobe = join(bin, 'ffprobe.exe');
const haveBinaries = existsSync(ffmpeg) && existsSync(ffprobe);

let dir = '';

/** The kinds of AVI people actually have: Xvid/DivX + MP3, MJPEG + PCM, and H.264 + MP3. */
const variants = {
  xvid: ['-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '3', '-c:a', 'libmp3lame', '-b:a', '128k'],
  mjpeg: ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le'],
  h264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'libmp3lame', '-b:a', '128k'],
};
type Variant = keyof typeof variants;
const files = {} as Record<Variant, string>;

function ff(args: string[]): Buffer {
  return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 1 << 30 });
}

function probe(id: string, path: string): MediaItem {
  const json = execFileSync(ffprobe, ffprobeArgs(path)).toString();
  return { ...parseProbe(JSON.parse(json), path), id, name: id, path };
}

function streams(path: string): { codec_type: string; codec_name: string; nb_frames?: string; nb_read_frames?: string; width: number; height: number }[] {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', path]).toString()).streams;
}

/**
 * The frame a player shows at n/30 s. By time, not decode order: MP3-in-AVI files carry
 * empty "hold the last frame" chunks that keep the sound in sync, and SimpleCut (like any
 * player) honours them.
 */
function frameAt(path: string, n: number): Buffer {
  return ff(['-i', path, '-vf', `fps=30,trim=start_frame=${n}:end_frame=${n + 1},scale=320:180`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
}

function psnr(a: Buffer, b: Buffer): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i]! - b[i]!) ** 2;
  const mse = se / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

beforeAll(() => {
  if (!haveBinaries) return;
  dir = mkdtempSync(join(tmpdir(), 'scut-avi-'));
  for (const [name, codec] of Object.entries(variants) as [Variant, string[]][]) {
    files[name] = join(dir, `clip ${name}.avi`);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=8', '-ac', '2', ...codec, '-shortest', files[name]]);
  }
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!haveBinaries)('AVI import (real FFmpeg)', () => {
  it.each(Object.keys(variants) as Variant[])('%s AVI imports and gets a playable proxy', (name) => {
    const path = files[name];
    expect(isImportable(path)).toBe(true);
    expect(isImportable(path.toUpperCase())).toBe(true);
    const m = probe(name, path);
    expect(m).toMatchObject({ kind: 'video', container: 'avi', hasAudio: true, width: 1280, height: 720, isVFR: false });
    expect(m.fps).toBeCloseTo(30, 3);
    expect(m.durationSec).toBeCloseTo(8, 0);
    expect(proxyReasons(m)).toContain('codec');

    const proxy = join(dir, `proxy-${name}.mp4`);
    execFileSync(ffmpeg, proxyArgs(m, path, proxy, 'libx264', false), { stdio: ['ignore', 'ignore', 'pipe'] });
    const s = streams(proxy);
    // One proxy frame per source frame slot, including any hold-frame chunks.
    const slots = streams(path).find((x) => x.codec_type === 'video')!.nb_frames;
    expect(s.find((x) => x.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, nb_read_frames: slots });
    expect(s.find((x) => x.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });
    expect(psnr(frameAt(proxy, 120), frameAt(path, 120))).toBeGreaterThan(30);
  });

  it('exports cuts from an AVI frame-accurately with its sound', () => {
    const avi = probe('avi', files.xvid);
    const tl = createTimeline(sequentialIds('t'));
    const clips: Clip[] = [
      { id: 'v0', trackId: 't1', mediaId: 'avi', kind: 'video', linkId: 'L0', start: 0, duration: 50, sourceIn: 10 },
      { id: 'a0', trackId: 't4', mediaId: 'avi', kind: 'audio', linkId: 'L0', start: 0, duration: 50, sourceIn: 10 },
      { id: 'v1', trackId: 't1', mediaId: 'avi', kind: 'video', linkId: 'L1', start: 50, duration: 50, sourceIn: 140 },
      { id: 'a1', trackId: 't4', mediaId: 'avi', kind: 'audio', linkId: 'L1', start: 50, duration: 50, sourceIn: 140 },
    ];
    const doc: ProjectDoc = {
      media: { avi },
      timeline: { ...tl, settings: { ...tl.settings, format: '1080p', fps: 30, locked: true }, clips: Object.fromEntries(clips.map((c) => [c.id, c])) },
    };
    const out = join(dir, 'from avi.mp4');
    const tempDir = mkdtempSync(join(dir, 'tmp-'));
    const plan = buildExportPlan({ doc, range: { start: 0, end: 100 }, outputPath: out, encoder: 'libx264', tempDir });
    for (const f of plan.files) writeFileSync(f.path, f.content);
    for (const job of plan.jobs) execFileSync(ffmpeg, job.args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const s = streams(out);
    expect(s.find((x) => x.codec_type === 'video')).toMatchObject({ codec_name: 'h264', nb_read_frames: '100' });
    expect(s.find((x) => x.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });
    for (const [outN, srcN] of [
      [20, 30],
      [70, 160],
    ] as const) {
      const o = frameAt(out, outN);
      const exact = psnr(o, frameAt(files.xvid, srcN));
      expect(exact, `output ${outN} vs source ${srcN}`).toBeGreaterThan(28);
      expect(exact).toBeGreaterThan(psnr(o, frameAt(files.xvid, srcN - 1)) + 3);
      expect(exact).toBeGreaterThan(psnr(o, frameAt(files.xvid, srcN + 1)) + 3);
    }
  });
});
