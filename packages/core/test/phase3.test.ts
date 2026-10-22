import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE,
  DEFAULT_SILENCE,
  DEFAULT_TRANSFORM,
  FORMATS,
  PROJECT_VERSION,
  addCaptions,
  applyCaptionStyle,
  applyReverse,
  attributeSources,
  autoColor,
  bakeLut,
  beatFramesInClip,
  buildExportPlan,
  buildFrameJob,
  captionsToSrt,
  captionsTrack,
  chapterList,
  cubeText,
  gradeFunction,
  groupWords,
  isIdentityTransform,
  isNeutralGrade,
  parseCube,
  parseProject,
  parseSilenceDetect,
  parseWhisperJson,
  pasteAttributes,
  pictureGeometry,
  pipTransform,
  punchInTransform,
  razorClips,
  reframeForFormat,
  removeSilences,
  reverseJobs,
  reverseRange,
  sampleCube,
  serializeProject,
  setClipSpeed,
  silenceRanges,
  sourceFrameAt,
  trimClips,
  updateTransforms,
  zoomScaleAt,
  type ColorGrade,
  type ProjectDoc,
  type Timeline,
} from '../src';
import { expectValid, layout, put, setup, videoMedia } from './helpers';

/** V1 a [0,100) linked to A1 aa; V1 b [100,200) linked to A1 ba; A2 music [0,300). */
function talk(): Timeline {
  const { tl } = setup();
  let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100, mediaId: 'm1', sourceIn: 30, linkId: 'La' });
  t = put(t, { id: 'aa', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', sourceIn: 30, linkId: 'La' });
  t = put(t, { id: 'b', trackId: 't1', start: 100, duration: 100, mediaId: 'm2', sourceIn: 0, linkId: 'Lb' });
  t = put(t, { id: 'ba', trackId: 't4', start: 100, duration: 100, mediaId: 'm2', sourceIn: 0, linkId: 'Lb' });
  return t;
}

describe('speed', () => {
  it('2x halves the length, moves what follows and keeps the source material', () => {
    const tl = setClipSpeed(talk(), ['a'], 2);
    expect(layout(tl)).toEqual({ V1: '0-50 m1@30 | 50-150 m2@0', A1: '0-50 m1@30 | 50-150 m2@0' });
    expect(tl.clips.a!.speed).toBe(2);
    expect(tl.clips.aa!.speed).toBe(2);
    expect(sourceFrameAt(tl.clips.a!, 10)).toBe(50);
    expect(layout(setClipSpeed(tl, ['a'], 1))).toEqual(layout(talk()));
    expect(setClipSpeed(tl, ['a'], 1).clips.a!.speed).toBeUndefined();
  });

  it('slow motion makes room by pushing later clips along', () => {
    const tl = setClipSpeed(talk(), ['a'], 0.5);
    expect(layout(tl)).toEqual({ V1: '0-200 m1@30 | 200-300 m2@0', A1: '0-200 m1@30 | 200-300 m2@0' });
    expectValid(tl);
  });

  it('razor and trims map timeline frames through the speed', () => {
    let tl = setClipSpeed(talk(), ['a'], 1.5);
    tl = razorClips(tl, ['a'], 21);
    const right = Object.values(tl.clips).find((c) => c.trackId === 't1' && c.start === 21)!;
    expect(right.sourceIn).toBeCloseTo(30 + 31.5, 6);
    // Start trim: 10 timeline frames = 15 source frames.
    const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60) };
    const trimmed = trimClips(tl, media, [right.id], 'start', 10);
    expect(trimmed.clips[right.id]!.sourceIn).toBeCloseTo(76.5, 6);
    // The end can't run past the media: 1800 source frames at 1.5x.
    const end = trimClips(tl, media, [right.id], 'end', 100000);
    const c = end.clips[right.id]!;
    expect(c.sourceIn + c.duration * 1.5).toBeLessThanOrEqual(1800 + 1e-6);
  });

  it('beats inside a sped-up clip land on the right frames', () => {
    const analysis = { music: true, confidence: 1, bpm: 120, beats: [1, 2, 3], downbeats: [1] };
    // 2x from source 0: second 2 (frame 60) shows at timeline frame 30.
    expect(beatFramesInClip(analysis, { start: 0, duration: 60, sourceIn: 0, speed: 2 }, 30)).toEqual([15, 30, 45]);
  });

  it('exports with setpts and pitch-preserving atempo, seeking by source time', () => {
    const tl = setClipSpeed(talk(), ['b'], 0.25);
    const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60) };
    const plan = buildExportPlan({ doc: { media, timeline: tl }, range: { start: 0, end: 500 }, outputPath: 'C:/o.mp4', encoder: 'libx264', tempDir: 'C:/tmp' });
    const g = plan.files.find((f) => f.path.endsWith('scut-graph.txt'))!.content;
    expect(g).toContain('setpts=PTS/0.250000,fps=30');
    expect(g).toContain('atempo=0.5,atempo=0.5');
    expect(plan.jobs[0]!.args.join(' ')).toContain('-t 3.4 -i C:\\Media\\m2.mp4');
  });
});

describe('transforms', () => {
  it('identity stays on the Phase 1 path; anything else is a transform', () => {
    expect(isIdentityTransform(undefined)).toBe(true);
    expect(isIdentityTransform(DEFAULT_TRANSFORM)).toBe(true);
    expect(isIdentityTransform({ ...DEFAULT_TRANSFORM, scale: 1.1 })).toBe(false);
    expect(isIdentityTransform({ ...DEFAULT_TRANSFORM, zoomTo: 1 })).toBe(true);
    const tl = updateTransforms(talk(), ['a'], { scale: 1.2 });
    expect(tl.clips.a!.transform?.scale).toBe(1.2);
    expect(updateTransforms(tl, ['a'], { scale: 1 }).clips.a!.transform).toBeUndefined();
    // Audio clips have no picture.
    expect(updateTransforms(talk(), ['aa'], { scale: 2 }).clips.aa!.transform).toBeUndefined();
  });

  it('geometry: fit, fill, crop and scale in whole output pixels', () => {
    const fit = pictureGeometry(DEFAULT_TRANSFORM, 1280, 720, 1920, 1080);
    expect(fit).toMatchObject({ pw: 1920, ph: 1080, cw: 1920, ch: 1080, left: 0, top: 0, cx: 960, cy: 540 });
    const vertical = pictureGeometry({ ...DEFAULT_TRANSFORM, fit: 'fill' }, 1920, 1080, 1080, 1920);
    expect(vertical).toMatchObject({ pw: 3413, ph: 1920 });
    const cropped = pictureGeometry({ ...DEFAULT_TRANSFORM, scale: 0.5, cropLeft: 0.25 }, 1920, 1080, 1920, 1080);
    expect(cropped).toMatchObject({ pw: 960, ph: 540, left: 240, cw: 720, ch: 540 });
    expect(cropped.sx).toBeCloseTo(0.25);
    expect(cropped.sw).toBeCloseTo(0.75);
  });

  it('picture-in-picture sits in the corner with a margin; punch-in zooms smoothly', () => {
    const m = videoMedia('cam');
    const t = { ...DEFAULT_TRANSFORM, ...pipTransform('bottomRight', m, '1080p') };
    const g = pictureGeometry(t, 1920, 1080, 1920, 1080);
    expect(g.pw).toBe(576);
    expect(Math.round(g.cx + g.pw / 2)).toBe(1920 - 43);
    expect(Math.round(g.cy + g.ph / 2)).toBe(1080 - 43);
    expect(g.radius).toBeGreaterThan(0);
    expect(g.border).toBe(6);
    const z = { ...DEFAULT_TRANSFORM, ...punchInTransform(1.25, true) };
    expect(zoomScaleAt(z, 0, 100)).toBe(1);
    expect(zoomScaleAt(z, 99, 100)).toBeCloseTo(1.25);
    expect(zoomScaleAt(z, 49.5, 100)).toBeCloseTo(1.125);
    expect(punchInTransform(1.1, false)).toEqual({ scale: 1.1, zoomTo: undefined });
  });

  it('Shorts mode fills the 9:16 frame with every clip and back again', () => {
    const media = { m1: videoMedia('m1'), m2: videoMedia('m2') };
    const v = reframeForFormat(talk(), media, 'vertical');
    expect(v.clips.a!.transform?.fit).toBe('fill');
    expect(v.clips.aa!.transform).toBeUndefined();
    expect(reframeForFormat(v, media, '1080p').clips.a!.transform).toBeUndefined();
    // A picture-in-picture keeps its own layout; a reframed clip keeps its sideways position.
    const pip = updateTransforms(talk(), ['b'], pipTransform('topLeft', media.m2, '1080p'));
    expect(reframeForFormat(pip, media, 'vertical').clips.b!.transform?.fit).toBe('fit');
    const shifted = updateTransforms(v, ['a'], { x: 0.3 });
    expect(reframeForFormat(shifted, media, 'vertical')).toBe(shifted);
  });

  it('exports transformed clips: crop, scale, mask, border, rotate, opacity, placement, zoom', () => {
    let tl = updateTransforms(talk(), ['a'], { scale: 0.5, x: 0.25, rotation: 90, opacity: 0.5, cropLeft: 0.1, radius: 0.1, borderWidth: 4 });
    tl = updateTransforms(tl, ['b'], { scale: 1, zoomTo: 1.25 });
    const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60) };
    const plan = buildExportPlan({
      doc: { media, timeline: tl },
      range: { start: 0, end: 200 },
      outputPath: 'C:/o.mp4',
      encoder: 'libx264',
      tempDir: 'C:/tmp',
      clipImages: { a: { mask: 'C:/tmp/mask.png', ring: 'C:/tmp/ring.png' } },
    });
    const g = plan.files.find((f) => f.path.endsWith('scut-graph.txt'))!.content;
    expect(g).toContain('crop=w=iw*0.900000:h=ih*1.000000:x=iw*0.100000:y=ih*0.000000,scale=864:540');
    expect(g).toContain('pad=960:540:96:0:color=black@0');
    expect(g).toContain('alphamerge');
    expect(g).toContain('rotate=a=1.57079633');
    expect(g).toContain('lut=a=val*0.5000');
    expect(g).toContain("overlay=x='floor(480.000-w/2+0.5)'");
    expect(g).toMatch(/perspective=x0='960\.000-960\.000\/\(\(1\+\(0\.25\)\*/);
    expect(plan.jobs[0]!.args.join(' ')).toContain('-i C:/tmp/mask.png');
    // Without the rendered mask the export refuses rather than drawing square corners.
    expect(() => buildExportPlan({ doc: { media, timeline: tl }, range: { start: 0, end: 200 }, outputPath: 'C:/o.mp4', encoder: 'libx264', tempDir: 'C:/tmp' })).toThrow(/mask/);
  });
});

describe('color', () => {
  it('a neutral grade is the identity', () => {
    expect(isNeutralGrade(DEFAULT_GRADE)).toBe(true);
    const f = gradeFunction(DEFAULT_GRADE);
    for (const v of [0, 0.2, 0.5, 0.9, 1]) {
      const [r, g, b] = f(v, v * 0.5, 1 - v);
      expect(r).toBeCloseTo(v, 6);
      expect(g).toBeCloseTo(v * 0.5, 6);
      expect(b).toBeCloseTo(1 - v, 6);
    }
  });

  it('exposure brightens, temperature warms, saturation -100 is grey, contrast keeps the ends', () => {
    const g = (p: Partial<ColorGrade>) => gradeFunction({ ...DEFAULT_GRADE, ...p });
    expect(g({ exposure: 1 })(0.4, 0.4, 0.4)[0]).toBeCloseTo(Math.pow(Math.pow(0.4, 2.2) * 2, 1 / 2.2), 6);
    const [wr, , wb] = g({ temperature: 50 })(0.5, 0.5, 0.5);
    expect(wr).toBeGreaterThan(0.5);
    expect(wb).toBeLessThan(0.5);
    const [r, gg, b] = g({ saturation: -100 })(0.8, 0.3, 0.1);
    expect(r).toBeCloseTo(gg, 6);
    expect(gg).toBeCloseTo(b, 6);
    const c = g({ contrast: 60 });
    expect(c(0, 0, 0)[0]).toBe(0);
    expect(c(1, 1, 1)[0]).toBe(1);
    expect(c(0.5, 0.5, 0.5)[0]).toBeCloseTo(0.5, 6);
    expect(c(0.25, 0.25, 0.25)[0]).toBeLessThan(0.25);
  });

  it('bakes to a .cube that parses back and samples like the function', () => {
    const grade: ColorGrade = { ...DEFAULT_GRADE, exposure: 0.4, contrast: 20, saturation: 15, temperature: -20, look: 'tealOrange', lookAmount: 0.7 };
    const lut = parseCube(cubeText(bakeLut(grade)));
    expect(lut.size).toBe(33);
    const f = gradeFunction(grade);
    for (const [r, g, b] of [[0.1, 0.5, 0.9], [0.73, 0.21, 0.4], [0.5, 0.5, 0.5]] as const) {
      const want = f(r, g, b);
      const got = sampleCube(lut, r, g, b);
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!)).toBeLessThan(0.01);
    }
  });

  it('reads 1D and 3D .cube files with domains, and applies an input LUT first', () => {
    const one = parseCube('TITLE "invert"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0\n');
    expect(sampleCube(one, 0.25, 0.5, 1)).toEqual([0.75, 0.5, 0]);
    const swap = ['LUT_3D_SIZE 2', '# swap red and blue'];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) swap.push(`${b} ${g} ${r}`);
    const lut = parseCube(swap.join('\n'));
    expect(sampleCube(lut, 0.2, 0.4, 0.8).map((v) => +v.toFixed(6))).toEqual([0.8, 0.4, 0.2]);
    expect(gradeFunction(DEFAULT_GRADE, lut)(1, 0, 0)).toEqual([0, 0, 1]);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/2 color rows|8 color rows/);
  });

  it('Auto Color neutralises a color cast and lifts a dark shot', () => {
    // A slightly blue, dark, flat gradient.
    const px = new Uint8Array(3 * 1000);
    for (let i = 0; i < 1000; i++) {
      const v = 50 + (i % 90);
      px.set([Math.round(v * 0.9), v, Math.round(v * 1.12)], i * 3);
    }
    const a = autoColor(px);
    expect(a.temperature).toBeGreaterThan(10);
    expect(a.exposure).toBeGreaterThan(0.3);
    expect(a.contrast).toBeGreaterThan(0);
    // White balance alone brings red and blue much closer together.
    const [r, , b] = gradeFunction({ ...DEFAULT_GRADE, temperature: a.temperature, tint: a.tint })(0.9 * 0.4, 0.4, 1.12 * 0.4);
    expect(Math.abs(Math.log(r / b))).toBeLessThan(Math.abs(Math.log(0.9 / 1.12)) / 2);
  });

  it('exports a grade as lut3d in RGB with escaped Windows paths', () => {
    const tl = { ...talk(), clips: { ...talk().clips, a: { ...talk().clips.a!, color: { ...DEFAULT_GRADE, exposure: 0.5 } } } };
    const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60) };
    const plan = buildExportPlan({ doc: { media, timeline: tl }, range: { start: 0, end: 200 }, outputPath: 'C:/o.mp4', encoder: 'libx264', tempDir: 'C:\\Temp\\x' });
    const g = plan.files.find((f) => f.path.endsWith('scut-graph.txt'))!.content;
    expect(g).toContain("scale=in_color_matrix=bt709:in_range=tv,format=gbrp,lut3d=file='C\\:/Temp/x/scut-grade-a.cube':interp=trilinear,scale=out_color_matrix=bt709:out_range=tv");
    const cube = plan.files.find((f) => f.path.endsWith('scut-grade-a.cube'));
    expect(cube?.content).toContain('LUT_3D_SIZE 33');
    expect(plan.tempFiles).toContain(cube!.path);
  });
});

describe('remove silences', () => {
  it('parses silencedetect, including a pause that runs to the end', () => {
    const log = '[silencedetect @ 0x] silence_start: 1.5\n[silencedetect @ 0x] silence_end: 2.75 | silence_duration: 1.25\n[silencedetect] silence_start: 9.2\n';
    expect(parseSilenceDetect(log, 10)).toEqual([
      { start: 1.5, end: 2.75 },
      { start: 9.2, end: 10 },
    ]);
  });

  it('pads pauses, trims to the clip edges, and ripple-deletes without chopping music', () => {
    const fps = 30;
    let tl = talk();
    tl = put(tl, { id: 'mus', trackId: 't5', start: 0, duration: 300, mediaId: 'song' });
    const ranges = silenceRanges(tl.clips.a!, [{ start: 0, end: 0.5 }, { start: 1, end: 2 }, { start: 3, end: 3.3333 }], fps, DEFAULT_SILENCE);
    expect(ranges).toEqual([
      { start: 0, end: 11 },
      { start: 34, end: 56 },
      { start: 94, end: 100 },
    ]);
    const out = removeSilences(tl, ['t1', 't4'], ranges);
    expect(layout(out)).toEqual({
      V1: '0-23 m1@41 | 23-61 m1@86 | 61-161 m2@0',
      A1: '0-23 m1@41 | 23-61 m1@86 | 61-161 m2@0',
      A2: '0-300 song@0',
    });
    expectValid(out);
  });
});

describe('reverse', () => {
  it('reverses the used part plus handles, in chunks that join in order', () => {
    const media = videoMedia('m1', 60);
    const clip = { sourceIn: 300, duration: 90, speed: 1 };
    expect(reverseRange(media, clip, 30)).toEqual({ inSec: 9, outSec: 14 });
    const { jobs, listText } = reverseJobs(media, 9, 14, 'C:/tmp', 'C:/cache/rev.mp4');
    expect(jobs).toHaveLength(4); // the last 2 s, the 2 s before, the first 1 s, then the join
    expect(jobs[0]!.args.join(' ')).toContain('-ss 12.000000 -t 2.066667');
    expect(jobs[0]!.args.join(' ')).toContain('fps=30,trim=end_frame=60,setpts=PTS-STARTPTS,reverse');
    expect(jobs[1]!.args.join(' ')).toContain('-ss 10.000000');
    expect(jobs[2]!.args.join(' ')).toContain('-ss 9.000000 -t 1.066667');
    expect(listText.split('\n')[1]).toBe("file 'rev-part-0000.mkv'");
    expect(jobs.at(-1)!.args).toContain('C:/cache/rev.mp4');
  });

  it('points the clip at the copy (first frame = original last frame) and back again', () => {
    const fps = 30;
    const orig = videoMedia('m1', 60);
    const copy = { ...videoMedia('r1', 5), derived: { from: 'm1', op: 'reverse' as const, inSec: 9, outSec: 14 } };
    const tl = put(setup().tl, { id: 'a', trackId: 't1', start: 0, duration: 90, mediaId: 'm1', sourceIn: 300 });
    const rev = applyReverse(tl, 'a', orig, copy);
    expect(rev.clips.a).toMatchObject({ mediaId: 'r1', sourceIn: 30 });
    const back = applyReverse(rev, 'a', copy, orig);
    expect(back.clips.a).toMatchObject({ mediaId: 'm1', sourceIn: 300 });
    expect(fps).toBe(30);
  });
});

describe('paste attributes', () => {
  it('copies only the chosen groups onto clips they suit', () => {
    let tl = talk();
    tl = updateTransforms(tl, ['a'], { scale: 0.5 });
    tl = { ...tl, clips: { ...tl.clips, a: { ...tl.clips.a!, color: { ...DEFAULT_GRADE, look: 'warm' } }, aa: { ...tl.clips.aa!, volumeDb: -6, fadeIn: 10 } } };
    const src = attributeSources([tl.clips.a!, tl.clips.aa!]);
    const out = pasteAttributes(tl, src, ['b'], ['color', 'audio']);
    expect(out.clips.b!.color?.look).toBe('warm');
    expect(out.clips.b!.transform).toBeUndefined();
    expect(out.clips.ba).toMatchObject({ volumeDb: -6, fadeIn: 10 });
  });
});

describe('captions', () => {
  const json = "{\"transcription\":[{\"offsets\":{\"from\":0,\"to\":4000},\"text\":\"x\",\"tokens\":[{\"text\":\"[_BEG_]\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":-1},{\"text\":\" Welcome\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":12},{\"text\":\" back\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":60},{\"text\":\" to\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":94},{\"text\":\" the\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":111},{\"text\":\" channel\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":137},{\"text\":\".\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":200},{\"text\":\" [\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":210},{\"text\":\"MUS\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":212},{\"text\":\"IC\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":214},{\"text\":\"]\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":216},{\"text\":\" Today\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":337},{\"text\":\" we\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":360},{\"text\":\" fly\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":374},{\"text\":\".\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":396},{\"text\":\"[_TT_200]\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":-1}]}]}";

  it('parses whisper words, glues punctuation and drops non-speech tags', () => {
    const words = parseWhisperJson(json, 10);
    expect(words.map((w) => w.text)).toEqual(['Welcome', 'back', 'to', 'the', 'channel.', 'Today', 'we', 'fly.']);
    expect(words[0]!.start).toBeCloseTo(10.07, 6);
    expect(words[0]!.end).toBeCloseTo(10.55, 6); // up to where the next word starts
    expect(words[4]!.end).toBeCloseTo(11.32 + 0.12 + 0.06 * 8, 6); // a pause follows: estimated from its length
  });

  it('groups words at sentence ends and pauses, then lays them on a captions track and as .srt', () => {
    const caps = groupWords(parseWhisperJson(json));
    expect(caps.map((c) => c.text)).toEqual(['Welcome back to the channel.', 'Today we fly.']);
    const { tl, ids } = setup();
    const { timeline, count } = addCaptions(tl, caps, 'boxed', { start: 0, end: 1000 }, ids);
    expect(count).toBe(2);
    const track = captionsTrack(timeline)!;
    expect(track.captions).toBe(true);
    const clips = Object.values(timeline.clips).sort((a, b) => a.start - b.start);
    expect(clips[0]).toMatchObject({ trackId: track.id, start: 2, duration: 56 });
    expect(clips[0]!.text).toMatchObject({ content: 'Welcome back to the channel.', box: true, preset: 'caption:boxed' });
    expect(captionsToSrt(timeline)).toBe('1\r\n00:00:00,067 --> 00:00:01,933\r\nWelcome back to the channel.\r\n\r\n2\r\n00:00:03,333 --> 00:00:04,067\r\nToday we fly.\r\n');
    // Re-running replaces instead of stacking; restyling keeps the words.
    const again = addCaptions(timeline, caps, 'clean', { start: 0, end: 1000 }, ids).timeline;
    expect(Object.keys(again.clips)).toHaveLength(2);
    const restyled = applyCaptionStyle(again, 'bold');
    expect(Object.values(restyled.clips).every((c) => c.text!.preset === 'caption:bold' && c.text!.color === '#ffe14d')).toBe(true);
  });
});

describe('chapters', () => {
  it('lists YouTube chapters, adds 00:00 Intro and explains what YouTube would reject', () => {
    const { tl } = setup();
    const withClip = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 30 * 125, mediaId: 'm1' });
    const markers = [
      { id: 'k1', frame: 30 * 30, label: 'Setup', color: 'green' as const, chapter: true },
      { id: 'k2', frame: 30 * 95, label: 'Flight', color: 'green' as const, chapter: true },
      { id: 'k3', frame: 30 * 100, label: 'Not a chapter', color: 'red' as const, chapter: false },
    ];
    const list = chapterList({ ...withClip, markers });
    expect(list.text).toBe('00:00 Intro\n00:30 Setup\n01:35 Flight');
    expect(list.problems).toEqual([]);
    const tooFew = chapterList({ ...withClip, markers: markers.slice(0, 1) });
    expect(tooFew.problems[0]).toMatch(/at least 3 chapters/);
  });
});

describe('export presets, audio only and thumbnails', () => {
  const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60) };
  const doc: ProjectDoc = { media, timeline: talk() };
  const base = { doc, range: { start: 0, end: 200 }, outputPath: 'C:/o.mp4', encoder: 'libx264' as const, tempDir: 'C:/tmp' };

  it('renders at the preset size', () => {
    const plan = buildExportPlan({ ...base, output: { width: 3840, height: 2160 } });
    expect(plan.width).toBe(3840);
    expect(plan.files[0]!.content).toContain('scale=3840:2160:force_original_aspect_ratio=decrease');
    expect(plan.bitrate.target).toBeGreaterThan(buildExportPlan(base).bitrate.target);
  });

  it('exports MP3 or WAV without any video', () => {
    const mp3 = buildExportPlan({ ...base, outputPath: 'C:/o.mp3', audioOnly: 'mp3' });
    const args = mp3.jobs[0]!.args.join(' ');
    expect(args).toContain('-map [aout] -c:a libmp3lame -b:a 320k');
    expect(args).not.toContain('[vout]');
    expect(mp3.files[0]!.content).not.toContain('[vout]');
    expect(buildExportPlan({ ...base, outputPath: 'C:/o.wav', audioOnly: 'wav' }).jobs[0]!.args).toContain('pcm_s16le');
  });

  it('grabs a single program frame as an RGB PNG', () => {
    const { job, files } = buildFrameJob({ doc, outputPath: 'C:/thumb.png', tempDir: 'C:/tmp' }, 120);
    expect(job.args.join(' ')).toContain('-ss 0.666667 -t'); // frame 120 is 20 frames into clip b
    expect(job.args.join(' ')).toContain('-map [png] -frames:v 1 -update 1 -c:v png C:/thumb.png');
    expect(files.at(-1)!.content).toContain('[vout]scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24[png]');
    expect(files.at(-1)!.content).not.toContain('aout');
  });
});

describe('project file v3', () => {
  it('round-trips speed, transforms, color, captions tracks and derived media', () => {
    let tl = setClipSpeed(talk(), ['a'], 1.5);
    tl = updateTransforms(tl, ['b'], { scale: 0.4, radius: 0.1 });
    tl = { ...tl, clips: { ...tl.clips, b: { ...tl.clips.b!, color: { ...DEFAULT_GRADE, saturation: 20, lut: { path: 'C:\\Luts\\log.cube', name: 'log' } } } } };
    tl = { ...tl, tracks: tl.tracks.map((t) => (t.id === 't3' ? { ...t, captions: true } : t)) };
    tl = razorClips(tl, ['a'], 21);
    const media = { m1: videoMedia('m1'), m2: { ...videoMedia('m2'), derived: { from: 'm1', op: 'reverse' as const, inSec: 1, outSec: 4 } } };
    const text = serializeProject({ media, timeline: tl }, { id: 'p', name: 'P' }, null);
    expect(JSON.parse(text).version).toBe(PROJECT_VERSION);
    expect(PROJECT_VERSION).toBe(3);
    const back = parseProject(text, null, 'win32').doc;
    expect(back.timeline.clips.a!.speed).toBe(1.5);
    const right = Object.values(back.timeline.clips).find((c) => c.trackId === 't1' && c.start === 21)!;
    expect(right.sourceIn).toBeCloseTo(61.5, 6);
    expect(back.timeline.clips.b!.transform).toMatchObject({ scale: 0.4, radius: 0.1, x: 0.5 });
    expect(back.timeline.clips.b!.color).toMatchObject({ saturation: 20, lut: { name: 'log' } });
    expect(back.timeline.tracks.find((t) => t.id === 't3')!.captions).toBe(true);
    expect(back.media.m2!.derived).toEqual({ from: 'm1', op: 'reverse', inSec: 1, outSec: 4 });
    expect(FORMATS.vertical.width).toBe(1080);
  });
});
