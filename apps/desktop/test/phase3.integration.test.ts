/**
 * Phase 3 and 4 exports rendered by the real FFmpeg (and whisper.cpp), checked against the
 * core math the preview uses: color grades (and an imported LUT), picture-in-picture with
 * rounded corners, smooth zoom, speed, reverse, thumbnails, MP3, silence detection and
 * auto captions.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE,
  DEFAULT_SILENCE,
  DEFAULT_TRANSFORM,
  addCaptions,
  buildExportPlan,
  buildFrameJob,
  buildSpeechJob,
  captionsToSrt,
  createTimeline,
  ffprobeArgs,
  gradeFunction,
  groupWords,
  parseCube,
  parseProbe,
  parseSilenceDetect,
  parseWhisperJson,
  pictureGeometry,
  pipTransform,
  reverseJobs,
  sequentialIds,
  silenceDetectArgs,
  whisperArgs,
  type Clip,
  type ColorGrade,
  type ExportRequest,
  type MediaItem,
  type ProjectDoc,
  type Timeline,
} from '@simplecut/core';

const bin = join(__dirname, '..', 'resources', 'bin');
const ffmpeg = join(bin, 'ffmpeg.exe');
const ffprobe = join(bin, 'ffprobe.exe');
const whisper = join(bin, 'whisper', 'whisper-cli.exe');
const model = join(__dirname, '..', '.models', 'ggml-base.en.bin');
const haveBinaries = existsSync(ffmpeg) && existsSync(ffprobe);
let dir = '';
const media: Record<string, MediaItem> = {};
const ff = (args: string[]) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });

/** Frame n as w×h RGB bytes (BT.709 TV range in, full range out: what the preview's decode shows). */
const rgb = (path: string, n: number, w = 160, h = 90, pre = '') =>
  ff(['-i', path, '-vf', `${pre}trim=start_frame=${n}:end_frame=${n + 1},scale=${w}:${h}:in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i]! - b[i]!) ** 2;
  return 10 * Math.log10((255 * 255) / (se / a.length || 1e-9));
}

function probe(id: string, path: string): MediaItem {
  return { ...parseProbe(JSON.parse(execFileSync(ffprobe, ffprobeArgs(path)).toString()), path), id, name: id, path };
}

beforeAll(() => {
  if (!haveBinaries) return;
  dir = mkdtempSync(join(tmpdir(), 'scut-p3-'));
  const a = join(dir, 'a.mp4');
  const b = join(dir, 'b.mp4');
  // a: smooth color gradients (good for checking color math); b: testsrc2, different every frame (good for frame timing), with a 660 Hz tone.
  ff(['-f', 'lavfi', '-i', 'gradients=s=640x360:r=30:d=10:c0=0x2a5ea8:c1=0xe0a050:c2=0x40a060:c3=0xc03060:speed=0.02', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-g', '15', '-pix_fmt', 'yuv420p', a]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=10', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', b]);
  media.a = probe('a', a);
  media.b = probe('b', b);
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

function render(name: string, doc: ProjectDoc, frames: number, extra: Partial<ExportRequest> = {}, ext = 'mp4'): string {
  const out = join(dir, `${name}.${ext}`);
  const tempDir = mkdtempSync(join(dir, 'tmp-'));
  const plan = buildExportPlan({ doc, range: { start: 0, end: frames }, outputPath: out, encoder: 'libx264', tempDir, ...extra });
  for (const f of plan.files) writeFileSync(f.path, f.content);
  for (const job of plan.jobs) execFileSync(ffmpeg, job.args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

describe.skipIf(!haveBinaries)('phase 3 exports (real FFmpeg)', () => {
  it('a color grade (with an imported LUT) exports like the core color function', () => {
    const lutPath = join(dir, 'warm look (v2).cube');
    // An input LUT that lifts blue a little, written the way grading apps do.
    const rows = ['TITLE "lift blue"', 'LUT_3D_SIZE 3'];
    for (let bi = 0; bi < 3; bi++) for (let gi = 0; gi < 3; gi++) for (let ri = 0; ri < 3; ri++) rows.push(`${ri / 2} ${gi / 2} ${Math.min(1, bi / 2 + 0.05)}`);
    writeFileSync(lutPath, rows.join('\n'));
    const input = parseCube(readFileSync(lutPath, 'utf8'));
    const grade: ColorGrade = { ...DEFAULT_GRADE, exposure: 0.4, contrast: 25, saturation: 30, temperature: 35, tint: -10, look: 'tealOrange', lookAmount: 0.6, lut: { path: lutPath, name: 'warm look' } };
    const tl = put(base(), { id: 'A', trackId: 't1', mediaId: 'a', start: 0, duration: 30, color: grade });
    const out = render('color', { media, timeline: tl }, 30, { inputLuts: { [lutPath]: input } });
    const f = gradeFunction(grade, input);
    for (const n of [0, 20]) {
      const src = rgb(media.a!.path, n);
      const want = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const [r, g, b] = f(src[i]! / 255, src[i + 1]! / 255, src[i + 2]! / 255);
        want.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)], i);
      }
      const got = rgb(out, n);
      expect(psnr(got, want), `frame ${n}`).toBeGreaterThan(33);
      // And it really changed the picture.
      expect(psnr(got, src)).toBeLessThan(25);
    }
  });

  it('picture-in-picture lands in the corner with rounded corners and a border', () => {
    const t = { ...DEFAULT_TRANSFORM, ...pipTransform('bottomRight', media.a!, '1080p') };
    const g = pictureGeometry(t, 640, 360, 1920, 1080);
    // The app renders these with canvas; here FFmpeg draws the same rounded rectangle.
    const r = g.radius;
    const inside = `lte(pow(max(0,abs(X-${g.pw / 2})-${g.pw / 2 - r}),2)+pow(max(0,abs(Y-${g.ph / 2})-${g.ph / 2 - r}),2),${r * r})`;
    const mask = join(dir, 'mask.png');
    const ring = join(dir, 'ring.png');
    ff(['-f', 'lavfi', '-i', `color=white@0:s=${g.pw}x${g.ph}`, '-vf', `format=rgba,geq=r=255:g=255:b=255:a='255*${inside}'`, '-frames:v', '1', mask]);
    ff(['-f', 'lavfi', '-i', `color=white@0:s=${g.pw}x${g.ph}`, '-vf', `format=rgba,geq=r=255:g=255:b=255:a='255*${inside}*gt(min(min(X,${g.pw - 1}-X),min(Y,${g.ph - 1}-Y)),${g.border - 1})*0+255*${inside}*lt(min(min(X,${g.pw - 1}-X),min(Y,${g.ph - 1}-Y)),${g.border})'`, '-frames:v', '1', ring]);
    let tl = put(base(), { id: 'B', trackId: 't1', mediaId: 'b', start: 0, duration: 10 });
    tl = put(tl, { id: 'P', trackId: 't2', mediaId: 'a', start: 0, duration: 10, transform: t });
    const out = render('pip', { media, timeline: tl }, 10, { clipImages: { P: { mask, ring } } });
    const full = (path: string) => ff(['-i', path, '-vf', 'trim=end_frame=1,scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
    const frame = full(out);
    const px = (x: number, y: number) => [...frame.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)];
    const left = Math.round(g.cx - g.pw / 2);
    const top = Math.round(g.cy - g.ph / 2);
    // Center of the PiP = center of clip a's first frame; the bars behind are elsewhere.
    const srcCenter = rgb(media.a!.path, 0, 1, 1, 'crop=20:20:310:170,');
    const c = px(Math.round(g.cx), Math.round(g.cy));
    for (let i = 0; i < 3; i++) expect(Math.abs(c[i]! - srcCenter[i]!)).toBeLessThan(12);
    // The very corner is rounded off: it shows the background (bars), not the clip.
    const corner = px(left + 1, top + 1);
    const pipEdge = px(left + Math.round(g.pw / 2), top + 1);
    expect(pipEdge.every((v) => v > 230)).toBe(true); // white border along the top edge
    expect(corner.every((v) => v > 230)).toBe(false); // corner cut away
    expect(left + g.pw).toBe(1920 - 43);
    expect(top + g.ph).toBe(1080 - 43);
  });

  it('smooth zoom starts at 100% and ends at the target, centered', () => {
    const t = { ...DEFAULT_TRANSFORM, scale: 1, zoomTo: 1.5 };
    const tl = put(base(), { id: 'A', trackId: 't1', mediaId: 'a', start: 0, duration: 31, transform: t });
    const out = render('zoom', { media, timeline: tl }, 31);
    expect(psnr(rgb(out, 0), rgb(media.a!.path, 0))).toBeGreaterThan(33);
    const zoomed = rgb(media.a!.path, 30, 160, 90, 'scale=960:540,crop=640:360:160:90,');
    expect(psnr(rgb(out, 30), zoomed)).toBeGreaterThan(30);
  });

  it('2x speed shows every other source frame and keeps the pitch', () => {
    const tl = put(base(), { id: 'B', trackId: 't1', mediaId: 'b', start: 0, duration: 60, sourceIn: 30, speed: 2, linkId: 'L' });
    const timeline = put(tl, { id: 'BA', trackId: 't4', mediaId: 'b', start: 0, duration: 60, sourceIn: 30, speed: 2, linkId: 'L' });
    const out = render('speed', { media, timeline }, 60);
    for (const k of [0, 25]) {
      const got = rgb(out, k);
      expect(psnr(got, rgb(media.b!.path, 30 + 2 * k)), `frame ${k}`).toBeGreaterThan(35);
      expect(psnr(got, rgb(media.b!.path, 30 + 2 * k + 1))).toBeLessThan(psnr(got, rgb(media.b!.path, 30 + 2 * k)));
    }
    // 660 Hz stays 660 Hz: count zero crossings over one second of the left channel.
    const pcm = ff(['-ss', '0.25', '-t', '1', '-i', out, '-af', 'pan=mono|c0=c0', '-f', 'f32le', 'pipe:1']);
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    let crossings = 0;
    for (let i = 1; i < s.length; i++) if (s[i - 1]! < 0 && s[i]! >= 0) crossings++;
    expect(Math.abs(crossings - 660)).toBeLessThan(15);
  });

  it('reverse: the copy plays the source backwards, frame for frame', () => {
    const out = join(dir, 'rev.mp4');
    const temp = mkdtempSync(join(dir, 'rev-'));
    const { jobs, listPath, listText } = reverseJobs(media.b!, 2, 5, temp, out);
    writeFileSync(listPath, listText);
    for (const j of jobs) execFileSync(ffmpeg, j.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const info = probe('rev', out);
    expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.1);
    expect(info.hasAudio).toBe(true);
    // Copy frame k = source frame (5 s * 30) - 1 - k.
    for (const k of [0, 59, 60, 89]) expect(psnr(rgb(out, k), rgb(media.b!.path, 149 - k)), `frame ${k}`).toBeGreaterThan(35);
  });

  it('a thumbnail grab is the exported frame, as an RGB PNG', () => {
    const tl = put(base(), { id: 'B', trackId: 't1', mediaId: 'b', start: 0, duration: 60, sourceIn: 15 });
    const png = join(dir, 'thumb.png');
    const tempDir = mkdtempSync(join(dir, 'frame-'));
    const { job, files } = buildFrameJob({ doc: { media, timeline: tl }, outputPath: png, tempDir }, 40);
    for (const f of files) writeFileSync(f.path, f.content);
    execFileSync(ffmpeg, job.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const thumb = ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(probe('thumb', png).width).toBe(1920);
    // Compared at full size: the source frame scaled to 1080p and converted to RGB the same way.
    const at = (n: number) =>
      ff(['-i', media.b!.path, '-vf', `trim=start_frame=${n}:end_frame=${n + 1},scale=1920:1080,scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
    expect(psnr(thumb, at(55))).toBeGreaterThan(50);
    expect(psnr(thumb, at(54))).toBeLessThan(30);
    expect(psnr(thumb, at(56))).toBeLessThan(30);
  });

  it('exports MP3 audio only', () => {
    const tl = put(base(), { id: 'BA', trackId: 't4', mediaId: 'b', start: 0, duration: 90 });
    const out = render('audio', { media, timeline: tl }, 90, { audioOnly: 'mp3' }, 'mp3');
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString());
    expect(info.streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(['mp3']);
    expect(Math.abs(Number(info.format.duration) - 3)).toBeLessThan(0.1);
  });

  it('finds the pauses in speech-like audio', () => {
    const wav = join(dir, 'pauses.wav');
    ff(['-f', 'lavfi', '-i', "sine=f=220:r=48000:d=6,volume='if(between(t,1.5,2.7)+between(t,4,4.3),0,0.5)':eval=frame", wav]);
    const r = spawnSync(ffmpeg, silenceDetectArgs(wav, 0, 6, DEFAULT_SILENCE), { encoding: 'utf8' });
    const res = parseSilenceDetect(r.stderr, 6);
    // Only the 1.2 s pause is long enough (0.3 s is shorter than the 0.6 s minimum).
    expect(res).toHaveLength(1);
    expect(res[0]!.start).toBeCloseTo(1.5, 1);
    expect(res[0]!.end).toBeCloseTo(2.7, 1);
  });
});

describe.skipIf(!haveBinaries || !existsSync(whisper) || !existsSync(model))('auto captions (real whisper.cpp)', () => {
  it('transcribes the timeline speech into timed captions and .srt', () => {
    // Speech made by Windows' built-in voice, placed 2 s into the timeline.
    const speech = join(dir, 'speech.wav');
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${speech}'); $s.Speak('Welcome back to the channel. Today we are flying the new drone over the lake.'); $s.Dispose()`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    media.speech = probe('speech', speech);
    let tl = put(base(), { id: 'S', trackId: 't4', mediaId: 'speech', start: 60, duration: Math.floor(media.speech.durationSec * 30) });
    tl = put(tl, { id: 'M', trackId: 't5', mediaId: 'b', start: 0, duration: 300 });
    tl = { ...tl, tracks: tl.tracks.map((t) => (t.id === 't5' ? { ...t, music: true } : t)) };
    const end = 60 + tl.clips.S!.duration;
    const wav = join(dir, 'speech16k.wav');
    const tempDir = mkdtempSync(join(dir, 'cap-'));
    const { job, files } = buildSpeechJob({ doc: { media, timeline: tl }, range: { start: 0, end }, outputPath: wav, tempDir });
    for (const f of files) writeFileSync(f.path, f.content);
    execFileSync(ffmpeg, job.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const base16 = join(tempDir, 'words');
    execFileSync(whisper, whisperArgs(model, wav, base16, 4), { stdio: ['ignore', 'ignore', 'pipe'] });
    const words = parseWhisperJson(readFileSync(`${base16}.json`, 'utf8'));
    const text = words.map((w) => w.text.toLowerCase()).join(' ');
    expect(text).toContain('welcome back to the channel');
    expect(text).toContain('drone');
    // The first word starts about 2 s in (where the clip is), not at 0 (the music isn't transcribed).
    expect(words[0]!.start).toBeGreaterThan(1.8);
    expect(words[0]!.start).toBeLessThan(2.6);
    const caps = groupWords(words);
    expect(caps.length).toBeGreaterThanOrEqual(2);
    const withCaps = addCaptions(tl, caps, 'clean', { start: 0, end }, sequentialIds('cap')).timeline;
    const srt = captionsToSrt(withCaps);
    expect(srt).toMatch(/^1\r\n00:00:0[12],\d{3} --> 00:00:0\d,\d{3}\r\nWelcome back to the channel\.\r\n/);
  }, 120_000);
});
