/**
 * Phase 2 exports rendered by the real FFmpeg, checked against the same math the preview
 * uses (core/timeline/transitions, core/audio/mix, core/text): dissolves, dips, slides,
 * titles, clip volume/fades, crossfades, ducking and loudness measurement.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_STYLE,
  addTitle,
  buildExportPlan,
  buildLoudnessJob,
  createTimeline,
  ffprobeArgs,
  parseLoudnorm,
  parseProbe,
  sequentialIds,
  setTransition,
  textAnimState,
  transitionFrameAt,
  updateClips,
  updateTrack,
  type Clip,
  type ExportRequest,
  type MediaItem,
  type ProjectDoc,
  type Timeline,
} from '@simplecut/core';

const bin = join(__dirname, '..', 'resources', 'bin');
const ffmpeg = join(bin, 'ffmpeg.exe');
const ffprobe = join(bin, 'ffprobe.exe');
const haveBinaries = existsSync(ffmpeg) && existsSync(ffprobe);
let dir = '';
const media: Record<string, MediaItem> = {};
const ff = (args: string[]) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });

/** Frame n as 160×90 luma. */
const luma = (path: string, n: number) =>
  ff(['-i', path, '-vf', `trim=start_frame=${n}:end_frame=${n + 1},scale=160:90`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i]! - b[i]!) ** 2;
  return 10 * Math.log10((255 * 255) / (se / a.length || 1e-9));
}

/** RMS level (dBFS) of an audio file's first channel between two times. */
function rmsDb(path: string, from: number, to: number): number {
  const pcm = ff(['-ss', String(from), '-t', String(to - from), '-i', path, '-af', 'pan=mono|c0=c0', '-f', 'f32le', 'pipe:1']);
  const f = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
  let s = 0;
  for (const v of f) s += v * v;
  return 10 * Math.log10(s / f.length + 1e-12);
}

function probe(id: string, path: string): MediaItem {
  return { ...parseProbe(JSON.parse(execFileSync(ffprobe, ffprobeArgs(path)).toString()), path), id, name: id, path };
}

beforeAll(() => {
  if (!haveBinaries) return;
  dir = mkdtempSync(join(tmpdir(), 'scut-p2-'));
  const a = join(dir, 'a.mp4');
  const b = join(dir, 'b.mp4');
  const tone = join(dir, 'tone.wav');
  const music = join(dir, 'music.wav');
  // Two visually different clips; each with a steady tone so levels are easy to measure.
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=10', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', a]);
  ff(['-f', 'lavfi', '-i', 'smptehdbars=s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=10', '-ac', '2', '-vf', 'drawbox=x=mod(t*200\\,600):y=100:w=40:h=40:color=white:t=fill', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', b]);
  ff(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=10', '-af', 'volume=0.5', tone]);
  ff(['-f', 'lavfi', '-i', 'sine=f=500:r=48000:d=10', '-af', 'volume=0.3', music]);
  media.a = probe('a', a);
  media.b = probe('b', b);
  media.tone = probe('tone', tone);
  media.music = probe('music', music);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function base(): Timeline {
  const tl = createTimeline(sequentialIds('t'));
  return { ...tl, settings: { ...tl.settings, locked: true } };
}
const put = (tl: Timeline, c: Partial<Clip> & Pick<Clip, 'id' | 'trackId' | 'mediaId' | 'start' | 'duration'>): Timeline => ({
  ...tl,
  clips: { ...tl.clips, [c.id]: { kind: tl.tracks.find((t) => t.id === c.trackId)!.kind, sourceIn: 0, ...c } as Clip },
});

function render(name: string, doc: ProjectDoc, frames: number, extra: Partial<ExportRequest> = {}): string {
  const out = join(dir, `${name}.mp4`);
  const tempDir = mkdtempSync(join(dir, 'tmp-'));
  const plan = buildExportPlan({ doc, range: { start: 0, end: frames }, outputPath: out, encoder: 'libx264', tempDir, ...extra });
  for (const f of plan.files) writeFileSync(f.path, f.content);
  for (const job of plan.jobs) execFileSync(ffmpeg, job.args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

/** A on V1 [0,90), B on V1 [90,180), each starting 2 s into its media (handles both sides). */
function cutDoc(type: 'dissolve' | 'dipBlack' | 'slide'): ProjectDoc {
  let tl = put(base(), { id: 'A', trackId: 't1', mediaId: 'a', start: 0, duration: 90, sourceIn: 60 });
  tl = put(tl, { id: 'B', trackId: 't1', mediaId: 'b', start: 90, duration: 90, sourceIn: 60 });
  return { media, timeline: setTransition(tl, 'B', 'in', { type, duration: 20 }) };
}

/** What the preview would draw for one frame, recomputed from the source frames (luma). */
function expectedFrame(doc: ProjectDoc, frame: number): Uint8Array {
  const tf = transitionFrameAt(doc.timeline, 't1', frame)!;
  const src = (c: Clip) => luma(media[c.mediaId]!.path, c.sourceIn + (frame - c.start));
  if (tf.mode === 'blend') {
    const a = src(tf.a);
    const b = src(tf.b);
    return a.map((v, i) => Math.round(v * (1 - tf.weight) + b[i]! * tf.weight));
  }
  const s = src(tf.clip);
  // Black in TV-range luma is 16.
  return s.map((v) => Math.round(16 + (v - 16) * tf.factor));
}

describe.skipIf(!haveBinaries)('phase 2 export with real FFmpeg', () => {
  for (const type of ['dissolve', 'dipBlack'] as const) {
    it(`${type} matches the preview math frame by frame`, () => {
      const doc = cutDoc(type);
      const out = render(type, doc, 180);
      const scores = [80, 85, 90, 95, 99].map((frame) => [frame, psnr(luma(out, frame), expectedFrame(doc, frame))] as const);
      for (const [frame, p] of scores) expect(p, `frame ${frame}`).toBeGreaterThan(32);
      // Outside the transition: the plain source frames.
      expect(psnr(luma(out, 50), luma(media.a!.path, 110))).toBeGreaterThan(32);
      expect(psnr(luma(out, 150), luma(media.b!.path, 120))).toBeGreaterThan(32);
    }, 120_000);
  }

  it('slide pushes A out to the left while B comes in from the right', () => {
    const doc = cutDoc('slide');
    const out = render('slide', doc, 180);
    const f = luma(out, 90); // halfway: weight 0.5
    const a = luma(media.a!.path, 60 + 90);
    const b = luma(media.b!.path, 60);
    // Left half of the output = right half of A; right half = left half of B.
    const half = (img: Uint8Array, x0: number) => {
      const out = new Uint8Array(80 * 90);
      for (let y = 0; y < 90; y++) for (let x = 0; x < 80; x++) out[y * 80 + x] = img[y * 160 + x0 + x]!;
      return out;
    };
    expect(psnr(half(f, 0), half(a, 80))).toBeGreaterThan(28);
    expect(psnr(half(f, 80), half(b, 0))).toBeGreaterThan(28);
  }, 120_000);

  it('titles appear with their animation (pop)', () => {
    // A transparent "title image": a white box in the middle of a 1920×1080 frame.
    const png = join(dir, 'title.png');
    ff(['-f', 'lavfi', '-i', 'color=c=black@0:s=1920x1080,format=rgba', '-vf', 'drawbox=x=760:y=440:w=400:h=200:color=white:t=fill:replace=1', '-frames:v', '1', png]);
    const text = { ...DEFAULT_TEXT_STYLE, content: 'x', animIn: 'pop' as const, animOut: 'fade' as const };
    const r = addTitle(base(), text, 30, 60, { trackId: 't2' }, sequentialIds('x'));
    const out = render('title', { media, timeline: r.timeline }, 120, { textImages: { [r.clipId]: png } });
    // Rendered over black, so the box is simply "the bright pixels".
    const center = (n: number) => luma(out, n)[45 * 160 + 80]!;
    const width = (n: number) => [...luma(out, n).slice(45 * 160, 46 * 160)].filter((v) => v > 40).length;
    expect(center(30)).toBeLessThan(24); // first frame: alpha 0
    expect(center(36)).toBeGreaterThan(90); // half way in
    expect(center(36)).toBeLessThan(170);
    expect(center(50)).toBeGreaterThan(225); // fully in, at rest
    expect(textAnimState(text, 6, 60, 30).scale).toBeGreaterThan(1.02);
    expect(width(36)).toBeGreaterThan(width(50)); // pop overshoot
    expect(center(88)).toBeLessThan(center(50)); // fading out over the last 9 frames
    expect(center(95)).toBeLessThan(24); // gone after the title ends
  }, 120_000);

  it('clip volume, fades and constant-power crossfades', () => {
    let tl = put(base(), { id: 'T1', trackId: 't4', mediaId: 'tone', start: 0, duration: 90, volumeDb: -6, fadeIn: 30 });
    tl = put(tl, { id: 'T2', trackId: 't4', mediaId: 'tone', start: 90, duration: 90, sourceIn: 90 });
    tl = setTransition(tl, 'T2', 'in', { type: 'crossfade', duration: 30 });
    const out = render('audio', { media, timeline: tl }, 180);
    const full = rmsDb(media.tone!.path, 4, 5);
    expect(rmsDb(out, 0, 0.1)).toBeLessThan(full - 20); // fading in from silence
    expect(rmsDb(out, 1.5, 2.5)).toBeCloseTo(full - 6, 0); // −6 dB clip
    expect(rmsDb(out, 4.5, 5.5)).toBeCloseTo(full, 0); // second clip at 0 dB
  }, 120_000);

  it('the music track ducks under dialogue', () => {
    let tl = put(base(), { id: 'M', trackId: 't5', mediaId: 'music', start: 0, duration: 240 });
    tl = updateTrack(tl, 't5', { music: true });
    const regions = [{ start: 3, end: 5 }];
    const out = render('duck', { media, timeline: tl }, 240, { duckRegions: regions });
    const normal = rmsDb(out, 0.5, 1.5);
    expect(rmsDb(out, 3.5, 4.5)).toBeCloseTo(normal - 12, 0);
    expect(rmsDb(out, 6.5, 7.5)).toBeCloseTo(normal, 0);
  }, 120_000);

  it('measures loudness with loudnorm', () => {
    const tl = put(base(), { id: 'T', trackId: 't4', mediaId: 'tone', start: 0, duration: 240 });
    const tempDir = mkdtempSync(join(dir, 'tmp-'));
    const { job, files } = buildLoudnessJob({ doc: { media, timeline: updateClips(tl, ['T'], {}) }, range: { start: 0, end: 240 }, tempDir });
    for (const f of files) writeFileSync(f.path, f.content);
    const r = spawnSync(ffmpeg, job.args, { encoding: 'utf8' });
    const m = parseLoudnorm(r.stderr);
    expect(m).not.toBeNull();
    // lavfi's sine is 1/8 amplitude, halved again: peak −24 dBFS on both channels.
    expect(m!.truePeakDb).toBeGreaterThan(-25);
    expect(m!.truePeakDb).toBeLessThan(-23);
    expect(m!.integratedLufs).toBeGreaterThan(-28);
    expect(m!.integratedLufs).toBeLessThan(-21);
  }, 120_000);
});
