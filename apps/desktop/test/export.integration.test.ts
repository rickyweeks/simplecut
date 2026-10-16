/**
 * Runs real exports with the bundled FFmpeg and checks the result frame by frame.
 * Proves the export graph is frame-accurate: each checked output frame must match the
 * exact source frame the timeline model says should be there, better than its neighbours.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HARDWARE_ENCODERS,
  buildExportPlan,
  createTimeline,
  encoderTestArgs,
  ffprobeArgs,
  parseProbe,
  sequentialIds,
  type Clip,
  type MediaItem,
  type ProjectDoc,
  type VideoEncoderId,
} from '@simplecut/core';

const bin = join(__dirname, '..', 'resources', 'bin');
const ffmpeg = join(bin, 'ffmpeg.exe');
const ffprobe = join(bin, 'ffprobe.exe');
const haveBinaries = existsSync(ffmpeg) && existsSync(ffprobe);

let dir = '';
const media: Record<string, MediaItem> = {};

function ff(args: string[]): Buffer {
  return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 1 << 30 });
}

function probe(id: string, path: string): MediaItem {
  const json = execFileSync(ffprobe, ffprobeArgs(path)).toString();
  return { ...parseProbe(JSON.parse(json), path), id, name: id, path };
}

/**
 * One decoded frame at 480x270. Luma ('gray') by default: comparing Y directly avoids any
 * YUV→RGB matrix guesswork (the untagged test sources vs the BT.709-tagged export).
 */
function frameAt(path: string, n: number, pixFmt: 'gray' | 'rgb24' = 'gray'): Buffer {
  return ff(['-i', path, '-vf', `trim=start_frame=${n}:end_frame=${n + 1},scale=480:270`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1']);
}

function psnr(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    se += d * d;
  }
  const mse = se / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** Asserts output frame `outN` is source frame `srcN` (and not a neighbour). */
function expectSameFrame(out: string, outN: number, src: string, srcN: number): void {
  const o = frameAt(out, outN);
  const exact = psnr(o, frameAt(src, srcN));
  const before = psnr(o, frameAt(src, srcN - 1));
  const after = psnr(o, frameAt(src, srcN + 1));
  expect(exact, `output ${outN} vs source ${srcN}`).toBeGreaterThan(30);
  expect(exact).toBeGreaterThan(before + 3);
  expect(exact).toBeGreaterThan(after + 3);
}

beforeAll(() => {
  if (!haveBinaries) return;
  dir = mkdtempSync(join(tmpdir(), 'scut-it-'));
  const talk = join(dir, 'talk ñ.mp4'); // space + non-ASCII on purpose
  const broll = join(dir, 'broll.mp4');
  const song = join(dir, 'song.mp3');
  const logo = join(dir, 'logo.png');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=20', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=20', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', broll]);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:r=44100:d=30', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', song]);
  ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=400x200,format=rgba', '-frames:v', '1', logo]);
  media.talk = probe('talk', talk);
  media.broll = probe('broll', broll);
  media.song = probe('song', song);
  media.logo = probe('logo', logo);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Talking head cut into 3 pieces (V1+A1), B-roll video only on V2, logo on V3, music on A2. */
function doc(): ProjectDoc {
  const tl = createTimeline(sequentialIds('t'));
  const clips: Clip[] = [];
  const pieces = [
    { start: 0, duration: 90, sourceIn: 0 },
    { start: 90, duration: 150, sourceIn: 150 },
    { start: 240, duration: 150, sourceIn: 400 },
  ];
  pieces.forEach((p, i) => {
    clips.push({ id: `v${i}`, trackId: 't1', mediaId: 'talk', kind: 'video', linkId: `L${i}`, ...p });
    clips.push({ id: `a${i}`, trackId: 't4', mediaId: 'talk', kind: 'audio', linkId: `L${i}`, ...p });
  });
  clips.push({ id: 'broll', trackId: 't2', mediaId: 'broll', kind: 'video', start: 120, duration: 60, sourceIn: 30 });
  clips.push({ id: 'logo', trackId: 't3', mediaId: 'logo', kind: 'video', start: 30, duration: 30, sourceIn: 0 });
  clips.push({ id: 'music', trackId: 't5', mediaId: 'song', kind: 'audio', start: 0, duration: 390, sourceIn: 0 });
  return { media, timeline: { ...tl, settings: { ...tl.settings, locked: true }, clips: Object.fromEntries(clips.map((c) => [c.id, c])) } };
}

function runExport(name: string, encoder: VideoEncoderId, maxInputsPerPass?: number, hwDecode = false): string {
  const out = join(dir, `${name}.mp4`);
  const tempDir = mkdtempSync(join(dir, 'tmp-'));
  const plan = buildExportPlan({ doc: doc(), range: { start: 0, end: 390 }, outputPath: out, encoder, tempDir, maxInputsPerPass, hwDecode });
  for (const f of plan.files) writeFileSync(f.path, f.content);
  for (const job of plan.jobs) execFileSync(ffmpeg, job.args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

function checkOutput(out: string): void {
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', out]).toString());
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  expect(v).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', pix_fmt: 'yuv420p' });
  expect(Number(v.nb_read_frames)).toBe(390);
  expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
  expect(Number(a.duration)).toBeCloseTo(13, 1);

  // Frame accuracy across cuts: piece 2 (source 150+10) and piece 3 (source 400+60).
  expectSameFrame(out, 100, media.talk!.path, 160);
  expectSameFrame(out, 300, media.talk!.path, 460);
  // B-roll on V2 covers V1 at timeline 150 (B-roll source 30+30), scaled 720p -> 1080p.
  expectSameFrame(out, 150, media.broll!.path, 60);
  // The half-transparent red logo on V3 tints the talking head under it.
  const logoFrame = frameAt(out, 45, 'rgb24');
  const center = (270 / 2) * 480 * 3 + (480 / 2) * 3;
  expect(logoFrame[center]!).toBeGreaterThan(logoFrame[center + 1]! + 40);
}

describe.skipIf(!haveBinaries)('export with real FFmpeg', () => {
  it('single pass (software x264) is frame-accurate', () => {
    checkOutput(runExport('single', 'libx264'));
  }, 180_000);

  it('chunked export joins seamlessly and stays frame-accurate', () => {
    checkOutput(runExport('chunked', 'libx264', 3));
  }, 180_000);

  it('GPU encode + GPU decode (when this machine has a hardware encoder) is frame-accurate', ({ skip }) => {
    const hw = HARDWARE_ENCODERS.find((id) => spawnSync(ffmpeg, encoderTestArgs(id)).status === 0);
    if (!hw) return skip();
    checkOutput(runExport(`gpu-${hw}`, hw, undefined, true));
  }, 180_000);

  it('mixes the dialogue and the music bed at full level', () => {
    const out = runExport('audio', 'libx264');
    // Loudness of the first 3 s: 440 Hz dialogue + 220 Hz mono music on both channels.
    const meanDb = (path: string, extra: string[] = []) => {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-t', '3', '-i', path, ...extra, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]);
    };
    const mixed = meanDb(out);
    const dialogue = meanDb(media.talk!.path);
    expect(Number.isFinite(mixed)).toBe(true);
    // Summing two equal-level uncorrelated tones adds about 3 dB; normalization would lower it.
    expect(mixed).toBeGreaterThan(dialogue + 1);
  }, 180_000);
});
