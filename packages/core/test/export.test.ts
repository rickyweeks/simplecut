import { describe, expect, it } from 'vitest';
import {
  ProgressParser,
  buildExportPlan,
  chunkRanges,
  exportVideoArgs,
  overallProgress,
  trackPieces,
  updateTrack,
  youtubeBitrate,
  type ExportRequest,
  type ProjectDoc,
} from '../src';
import { audioMedia, imageMedia, put, setup, videoMedia } from './helpers';

/** The Phase 1 acceptance scenario: a talking head cut into 3 pieces, B-roll on V2, music on A2. */
function acceptanceDoc(): ProjectDoc {
  const { tl } = setup();
  let t = tl;
  const pieces = [
    { start: 0, duration: 300, sourceIn: 0 },
    { start: 300, duration: 450, sourceIn: 450 }, // a mistake (300-450) was cut out
    { start: 750, duration: 600, sourceIn: 1200 },
  ];
  pieces.forEach((p, i) => {
    t = put(t, { id: `th${i}`, trackId: 't1', mediaId: 'talk', linkId: `L${i}`, ...p });
    t = put(t, { id: `ta${i}`, trackId: 't4', mediaId: 'talk', linkId: `L${i}`, ...p });
  });
  t = put(t, { id: 'broll', trackId: 't2', mediaId: 'broll', start: 400, duration: 150, sourceIn: 60 });
  t = put(t, { id: 'music', trackId: 't5', mediaId: 'song', start: 0, duration: 1350, sourceIn: 0 });
  return {
    media: {
      talk: videoMedia('talk', 600),
      broll: videoMedia('broll', 20),
      song: audioMedia('song', 180),
    },
    timeline: t,
  };
}

const request = (doc: ProjectDoc, extra: Partial<ExportRequest> = {}): ExportRequest => ({
  doc,
  range: { start: 0, end: 1350 },
  outputPath: 'C:\\Out\\My Video.mp4',
  encoder: 'libx264',
  tempDir: 'C:/Temp/scut',
  ...extra,
});

const countInputs = (args: string[]) => args.filter((a) => a === '-i').length;
const graphOf = (plan: ReturnType<typeof buildExportPlan>, i = 0) => plan.files.filter((f) => f.path.endsWith('.txt'))[i]!.content;

describe('export graph builder', () => {
  it('builds one pass for the acceptance edit, sharing inputs between linked video and audio', () => {
    const plan = buildExportPlan(request(acceptanceDoc()));
    expect(plan.jobs).toHaveLength(1);
    const args = plan.jobs[0]!.args;
    // 3 talking-head pieces (video+audio share an input) + B-roll + music.
    expect(countInputs(args)).toBe(5);
    // Accurate input seeks to the kept source ranges.
    expect(args.join(' ')).toContain('-ss 15 -t 15.066667 -i C:\\Media\\talk.mp4');
    expect(args.join(' ')).toContain('-ss 40 -t 20.066667 -i C:\\Media\\talk.mp4');
    expect(args.join(' ')).toContain('-ss 2 -t 5.066667 -i C:\\Media\\broll.mp4');
    expect(args).toEqual(expect.arrayContaining(['-filter_complex_script', 'C:/Temp/scut/scut-graph.txt', '-map', '[vout]', '-map', '[aout]']));
    expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual(['-frames:v', '1350']);
    expect(args.at(-1)).toBe('C:\\Out\\My Video.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '384k', '-movflags', '+faststart', '-r', '30', '-fps_mode', 'cfr']));

    const graph = graphOf(plan);
    // V1 is the opaque base; B-roll on V2 is overlaid on top of it.
    expect(graph).toContain('concat=n=3:v=1:a=0[tv0]');
    expect(graph).toContain('concat=n=3:v=1:a=0[tv1]'); // gap, B-roll, gap
    expect(graph).toContain('[tv0][tv1]overlay=0:0:format=yuv420:eof_action=pass[ov1]');
    expect(graph).toContain('color=c=black@0:s=1920x1080:r=30,format=yuva420p,trim=end_frame=400');
    // Every clip is conformed to the timeline rate and fitted into the frame.
    expect(graph).toContain('fps=30,tpad=stop_mode=clone:stop=-1,trim=end_frame=450');
    expect(graph).toContain('scale=1920:1080:force_original_aspect_ratio=decrease');
    // Talking head and music summed without normalization (matches the preview mix).
    expect(graph).toContain('[ta0][ta1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]');
    // Sample-exact audio pieces: 450 frames at 30 fps = 720000 samples.
    expect(graph).toContain('atrim=end_sample=720000');
    expect(plan.frames).toBe(1350);
    expect(plan.durationSec).toBe(45);
    expect(plan.estimatedBytes).toBe(Math.round(((8_000_000 + 384_000) * 45) / 8));
  });

  it('leaves out muted, non-soloed and hidden tracks', () => {
    const doc = acceptanceDoc();
    const muted = { ...doc, timeline: updateTrack(doc.timeline, 't5', { muted: true }) };
    expect(graphOf(buildExportPlan(request(muted)))).toContain('[ta0]anull[aout]');
    const solo = { ...doc, timeline: updateTrack(doc.timeline, 't5', { solo: true }) };
    const soloPlan = buildExportPlan(request(solo));
    expect(countInputs(soloPlan.jobs[0]!.args)).toBe(5); // talk inputs still feed V1
    expect(graphOf(soloPlan)).not.toContain('amix');
    const hidden = { ...doc, timeline: updateTrack(doc.timeline, 't2', { hidden: true }) };
    expect(graphOf(buildExportPlan(request(hidden)))).not.toContain('overlay');
  });

  it('exports just the In/Out range', () => {
    const plan = buildExportPlan(request(acceptanceDoc(), { range: { start: 30, end: 90 } }));
    const args = plan.jobs[0]!.args;
    expect(countInputs(args)).toBe(2); // talking head (shared) + music
    expect(args.join(' ')).toContain('-ss 1 -t 2.066667 -i C:\\Media\\talk.mp4');
    expect(plan.frames).toBe(60);
    expect(graphOf(plan)).toContain('atrim=end_sample=96000');
  });

  it('renders black and silence for an empty range', () => {
    const { tl } = setup();
    const plan = buildExportPlan(request({ media: {}, timeline: tl }, { range: { start: 0, end: 30 } }));
    expect(countInputs(plan.jobs[0]!.args)).toBe(0);
    expect(graphOf(plan)).toContain('color=c=black:s=1920x1080:r=30,trim=end_frame=30');
    expect(graphOf(plan)).toContain('anullsrc=r=48000:cl=stereo,atrim=end_sample=48000');
    expect(() => buildExportPlan(request({ media: {}, timeline: tl }, { range: { start: 10, end: 10 } }))).toThrow();
  });

  it('handles stills, transparent PNGs, mono audio and GPU encoders', () => {
    const { tl } = setup();
    let t = put(tl, { id: 'logo', trackId: 't1', mediaId: 'logo', start: 0, duration: 60 });
    t = put(t, { id: 'vo', trackId: 't4', mediaId: 'vo', start: 0, duration: 60 });
    const vo = { ...audioMedia('vo'), audioChannels: 1 };
    const plan = buildExportPlan(
      request({ media: { logo: imageMedia('logo'), vo }, timeline: t }, { range: { start: 0, end: 60 }, encoder: 'h264_amf', hwDecode: true }),
    );
    const args = plan.jobs[0]!.args;
    expect(args.join(' ')).toContain('-loop 1 -framerate 30 -t 2.033333 -i C:\\Media\\logo.png');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'h264_amf', '-pix_fmt', 'nv12']));
    const graph = graphOf(plan);
    expect(graph).toContain('pan=stereo|c0=c0|c1=c0');
    // A PNG on the bottom track keeps its alpha and is laid over black.
    expect(graph).toContain('[vbase][tv0]overlay');
  });

  it('splits very long edits into chunks and joins them losslessly', () => {
    const doc = acceptanceDoc();
    const plan = buildExportPlan(request(doc, { maxInputsPerPass: 3 }));
    expect(plan.jobs.length).toBeGreaterThan(2);
    const chunks = plan.jobs.slice(0, -1);
    const frames = chunks.map((j) => Number(j.args[j.args.indexOf('-frames:v') + 1]));
    expect(frames.reduce((a, b) => a + b, 0)).toBe(1350);
    for (const j of chunks) {
      expect(j.args).toEqual(expect.arrayContaining(['-c:a', 'pcm_f32le']));
      expect(j.args.at(-1)).toMatch(/scut-part-\d{3}\.mkv$/);
    }
    const final = plan.jobs.at(-1)!;
    expect(final.args).toEqual(expect.arrayContaining(['-f', 'concat', '-c:v', 'copy', '-c:a', 'aac']));
    const list = plan.files.find((f) => f.path.endsWith('.ffconcat'))!;
    expect(list.content.split('\n').filter((l) => l.startsWith('file '))).toHaveLength(chunks.length);
    expect(plan.tempFiles).toEqual(expect.arrayContaining([list.path]));
  });

  it('chunks cover the range back to back', () => {
    const doc = acceptanceDoc();
    const chunks = chunkRanges(doc.timeline, { start: 0, end: 1350 }, 3);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(1350);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
  });

  it('splits tracks into pieces that exactly cover the range', () => {
    const doc = acceptanceDoc();
    expect(trackPieces(doc.timeline, 't2', { start: 0, end: 1350 }).map((p) => [p.start, p.end, p.clip?.id ?? null])).toEqual([
      [0, 400, null],
      [400, 550, 'broll'],
      [550, 1350, null],
    ]);
  });
});

describe('YouTube presets', () => {
  it('uses YouTube recommended bitrates', () => {
    expect(youtubeBitrate(1920, 1080, 30).target).toBe(8_000_000);
    expect(youtubeBitrate(1920, 1080, 60).target).toBe(12_000_000);
    expect(youtubeBitrate(1080, 1920, 30).target).toBe(8_000_000);
    expect(youtubeBitrate(3840, 2160, 24).target).toBe(40_000_000);
    expect(youtubeBitrate(3840, 2160, 60).target).toBe(60_000_000);
  });

  it('uses a closed half-second GOP', () => {
    expect(exportVideoArgs('libx264', youtubeBitrate(1920, 1080, 30), 30)).toEqual(expect.arrayContaining(['-g', '15', '-profile:v', 'high']));
    expect(exportVideoArgs('h264_nvenc', youtubeBitrate(1920, 1080, 60), 60)).toEqual(expect.arrayContaining(['-g', '30', '-b:v', '12000k']));
  });
});

describe('FFmpeg progress', () => {
  it('parses -progress blocks split across chunks', () => {
    const p = new ProgressParser();
    expect(p.push('frame=10\nout_time_us=1500000\ntotal_size=4096\nspe')).toEqual([]);
    expect(p.push('ed=2.5x\nprogress=continue\nout_time_us=N/A\nprogress=end\n')).toEqual([
      { outTimeSec: 1.5, totalSizeBytes: 4096, speed: 2.5, done: false },
      { outTimeSec: 0, totalSizeBytes: 0, speed: 0, done: true },
    ]);
  });

  it('weights progress across jobs by duration', () => {
    expect(overallProgress([10, 30], 0, 5)).toBeCloseTo(0.125);
    expect(overallProgress([10, 30], 1, 15)).toBeCloseTo(0.625);
    expect(overallProgress([10], 0, 99)).toBe(1);
  });
});
