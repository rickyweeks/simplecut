import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_STYLE,
  PROJECT_VERSION,
  TEXT_PRESETS,
  addBeatMarkers,
  addMusic,
  addTitle,
  buildExportPlan,
  buildLoudnessJob,
  clipGainAt,
  crossfadeGains,
  cutAllTracks,
  cutClipsOnBeats,
  cutNearPlayhead,
  dialogueRegions,
  duckAmountAt,
  duckVolumeFilters,
  effectiveFades,
  expandSelection,
  musicBeatFrames,
  normalizationGain,
  parseLoudnorm,
  parseProject,
  serializeProject,
  setTransition,
  snapTargets,
  textAnimState,
  textAnimationFilters,
  trackTransitions,
  transitionFrameAt,
  updateClips,
  updateTrack,
  type ProjectDoc,
  type Timeline,
} from '../src';
import { audioMedia, layout, put, setup, videoMedia } from './helpers';

/** V1: a [0,100) b [100,200) (linked to A1 copies); A2 empty. */
function twoClips(): Timeline {
  const { tl } = setup();
  let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100, mediaId: 'm1', sourceIn: 50, linkId: 'La' });
  t = put(t, { id: 'aa', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', sourceIn: 50, linkId: 'La' });
  t = put(t, { id: 'b', trackId: 't1', start: 100, duration: 100, mediaId: 'm2', sourceIn: 50, linkId: 'Lb' });
  t = put(t, { id: 'ba', trackId: 't4', start: 100, duration: 100, mediaId: 'm2', sourceIn: 50, linkId: 'Lb' });
  return t;
}

describe('transitions', () => {
  it('a dissolve on a cut is centered and blends B in linearly', () => {
    const tl = setTransition(twoClips(), 'b', 'in', { type: 'dissolve', duration: 30 });
    const [t] = trackTransitions(tl, 't1');
    expect(t).toMatchObject({ kind: 'cut', cut: 100, duration: 30, h1: 15, h2: 15 });
    expect(transitionFrameAt(tl, 't1', 84)).toBeNull();
    expect(transitionFrameAt(tl, 't1', 85)).toMatchObject({ mode: 'blend', type: 'dissolve', weight: 0 });
    expect(transitionFrameAt(tl, 't1', 100)).toMatchObject({ mode: 'blend', weight: 0.5 });
    expect(transitionFrameAt(tl, 't1', 114)).toMatchObject({ weight: 29 / 30 });
    expect(transitionFrameAt(tl, 't1', 115)).toBeNull();
  });

  it('dips fade A out to the color before the cut and B in after it', () => {
    const tl = setTransition(twoClips(), 'b', 'in', { type: 'dipBlack', duration: 20 });
    expect(transitionFrameAt(tl, 't1', 90)).toMatchObject({ mode: 'fade', clip: { id: 'a' }, factor: 1, color: 'black' });
    expect(transitionFrameAt(tl, 't1', 95)).toMatchObject({ clip: { id: 'a' }, factor: 0.5 });
    expect(transitionFrameAt(tl, 't1', 100)).toMatchObject({ clip: { id: 'b' }, factor: 0 });
    expect(transitionFrameAt(tl, 't1', 105)).toMatchObject({ clip: { id: 'b' }, factor: 0.5 });
  });

  it('with nothing before or after, transitions fade the clip in or out', () => {
    let tl = setTransition(twoClips(), 'a', 'in', { type: 'dissolve', duration: 10 });
    tl = setTransition(tl, 'b', 'out', { type: 'dipWhite', duration: 10 });
    expect(transitionFrameAt(tl, 't1', 0)).toMatchObject({ mode: 'fade', factor: 0, color: 'none' });
    expect(transitionFrameAt(tl, 't1', 195)).toMatchObject({ mode: 'fade', factor: 0.5, color: 'white' });
  });

  it('an out-transition at a cut moves onto the next clip, and durations are clamped', () => {
    const tl = setTransition(twoClips(), 'a', 'out', { type: 'dissolve', duration: 500 });
    expect(tl.clips.a!.transitionOut).toBeUndefined();
    expect(tl.clips.b!.transitionIn).toEqual({ type: 'dissolve', duration: 500 });
    expect(trackTransitions(tl, 't1')[0]).toMatchObject({ duration: 200 });
  });

  it('video transitions only go on video tracks and crossfades only on audio', () => {
    const tl = twoClips();
    expect(setTransition(tl, 'ba', 'in', { type: 'dissolve', duration: 10 })).toBe(tl);
    expect(setTransition(tl, 'b', 'in', { type: 'crossfade', duration: 10 })).toBe(tl);
    expect(setTransition(tl, 'ba', 'in', { type: 'crossfade', duration: 10 }).clips.ba!.transitionIn?.type).toBe('crossfade');
  });

  it('finds the cut nearest the playhead for Ctrl+D', () => {
    const tl = twoClips();
    expect(cutNearPlayhead(tl, 't1', 97, 15)).toMatchObject({ clip: { id: 'b' }, edge: 'in' });
    expect(cutNearPlayhead(tl, 't1', 198, 15)).toMatchObject({ clip: { id: 'b' }, edge: 'out' });
    expect(cutNearPlayhead(tl, 't1', 50, 15)).toBeNull();
  });

  it('razor cuts keep each edge effect on the piece that still has that edge', () => {
    let tl = setTransition(twoClips(), 'b', 'in', { type: 'dissolve', duration: 20 });
    tl = setTransition(tl, 'b', 'out', { type: 'dipBlack', duration: 20 });
    tl = updateClips(tl, ['ba'], { fadeIn: 10, fadeOut: 10 });
    const cut = cutAllTracks(tl, 150);
    const pieces = Object.values(cut.clips).filter((c) => c.mediaId === 'm2').sort((x, y) => x.start - y.start || x.kind.localeCompare(y.kind));
    const [audioLeft, videoLeft, audioRight, videoRight] = pieces;
    expect(videoLeft!.transitionIn?.type).toBe('dissolve');
    expect(videoLeft!.transitionOut).toBeUndefined();
    expect(videoRight!.transitionIn).toBeUndefined();
    expect(videoRight!.transitionOut?.type).toBe('dipBlack');
    expect([audioLeft!.fadeIn, audioLeft!.fadeOut]).toEqual([10, undefined]);
    expect([audioRight!.fadeIn, audioRight!.fadeOut]).toEqual([undefined, 10]);
  });
});

describe('audio mix math', () => {
  it('clip gain = volume × linear fades', () => {
    const clip = { id: 'c', trackId: 't4', mediaId: 'm', kind: 'audio' as const, start: 100, duration: 100, sourceIn: 0, volumeDb: -6, fadeIn: 20, fadeOut: 40 };
    expect(clipGainAt(clip, 100)).toBe(0);
    expect(clipGainAt(clip, 110)).toBeCloseTo(0.5 * 0.5012, 3);
    expect(clipGainAt(clip, 150)).toBeCloseTo(0.5012, 3);
    expect(clipGainAt(clip, 180)).toBeCloseTo(0.5 * 0.5012, 3);
    expect(effectiveFades({ duration: 30, fadeIn: 40, fadeOut: 20 })).toEqual({ fadeIn: 20, fadeOut: 10 });
  });

  it('crossfades keep constant power', () => {
    for (const w of [0, 0.25, 0.5, 0.9, 1]) {
      const { a, b } = crossfadeGains(w);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
    expect(crossfadeGains(0)).toEqual({ a: 1, b: 0 });
  });

  it('finds dialogue from waveform peaks and ducks the music around it', () => {
    let { tl } = setup();
    tl = put(tl, { id: 'v', trackId: 't4', start: 30, duration: 300, mediaId: 'voice' });
    tl = put(tl, { id: 'm', trackId: 't5', start: 0, duration: 600, mediaId: 'song' });
    tl = updateTrack(tl, 't5', { music: true });
    const peaks = new Uint8Array(1000);
    for (let i = 200; i < 500; i++) peaks[i] = 120; // talking 2.0–5.0 s into the voice file
    for (let i = 520; i < 540; i++) peaks[i] = 120; // a 0.2 s word right after → merged
    const media = { voice: { ...audioMedia('voice'), path: 'voice.wav' }, song: { ...audioMedia('song'), path: 'song.mp3' } };
    const regions = dialogueRegions(tl, media, { 'voice.wav': peaks, 'song.mp3': new Uint8Array(6000).fill(200) });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.start).toBeCloseTo(3, 2); // clip starts at 1 s, speech 2 s in
    expect(regions[0]!.end).toBeCloseTo(6.4, 2);
    expect(duckAmountAt(regions, 1)).toBe(0);
    expect(duckAmountAt(regions, 4)).toBe(1);
    expect(duckAmountAt(regions, 3 - 0.1 - 0.125)).toBeCloseTo(0.5, 3);
    expect(duckAmountAt(regions, 6.4 + 0.3)).toBeCloseTo(0.5, 3);
    const [filter] = duckVolumeFilters(regions, -12, 0, 10);
    expect(filter).toMatch(/^volume=volume='pow\(10,-12\*clip\(clip\(\(t-2\.6500\)\/0\.25,0,1\)\*clip\(\(7\.0000-t\)\/0\.6,0,1\),0,1\)\/20\)':eval=frame$/);
  });

  it('normalizes to −14 LUFS without pushing peaks over −1 dBTP', () => {
    expect(normalizationGain({ integratedLufs: -20, truePeakDb: -10 })).toEqual({ gainDb: 6, limitedByPeak: false });
    expect(normalizationGain({ integratedLufs: -20, truePeakDb: -3 })).toEqual({ gainDb: 2, limitedByPeak: true });
    expect(normalizationGain({ integratedLufs: -10, truePeakDb: -0.5 })).toEqual({ gainDb: -4, limitedByPeak: false });
    const stderr = '[Parsed_loudnorm_0 @ 0000] \n{\n\t"input_i" : "-23.41",\n\t"input_tp" : "-6.02",\n\t"input_lra" : "5.10"\n}\n';
    expect(parseLoudnorm(stderr)).toEqual({ integratedLufs: -23.41, truePeakDb: -6.02 });
    expect(parseLoudnorm('nothing')).toBeNull();
  });
});

describe('music track and beats', () => {
  const song = { ...audioMedia('song', 60), beats: { music: true, confidence: 0.9, bpm: 120, beats: [0.5, 1, 1.5, 2, 2.5, 3], downbeats: [0.5, 2.5] } };

  it('Add music puts the song on an empty non-dialogue track and marks it as the music track', () => {
    const { tl, ids } = setup();
    const r = addMusic(tl, song, ids);
    expect(r.trackId).toBe('t5');
    expect(r.timeline.tracks.find((t) => t.id === 't5')!.music).toBe(true);
    expect(layout(r.timeline)).toEqual({ A2: '0-1800 song@0' });
    // A second song is appended on the same track.
    const r2 = addMusic(r.timeline, { ...song, id: 'song2' }, ids);
    expect(layout(r2.timeline).A2).toBe('0-1800 song@0 | 1800-3600 song2@0');
  });

  it('only one track is the music track', () => {
    const { tl } = setup();
    const t = updateTrack(updateTrack(tl, 't5', { music: true }), 't6', { music: true });
    expect(t.tracks.filter((x) => x.music).map((x) => x.id)).toEqual(['t6']);
  });

  it('exposes beats for snapping, markers and cutting on the beat', () => {
    const { tl, ids } = setup();
    const { timeline } = addMusic(tl, song, ids);
    const media = { song };
    const beats = musicBeatFrames(timeline, media);
    expect(beats).toEqual([15, 30, 45, 60, 75, 90]);
    expect(musicBeatFrames(timeline, media, 'downbeats')).toEqual([15, 75]);
    expect(snapTargets(timeline, { extra: beats })).toEqual(expect.arrayContaining([15, 30, 45]));
    expect(addBeatMarkers(timeline, media, 'downbeats', ids).markers.map((m) => [m.frame, m.color])).toEqual([
      [15, 'orange'],
      [75, 'orange'],
    ]);
    let edit = put(timeline, { id: 'g', trackId: 't1', start: 0, duration: 100, mediaId: 'game', linkId: 'Lg' });
    edit = put(edit, { id: 'ga', trackId: 't4', start: 0, duration: 100, mediaId: 'game', linkId: 'Lg' });
    const cut = cutClipsOnBeats(edit, expandSelection(edit, ['g']), beats, ids);
    expect(layout(cut).V1).toBe('0-15 game@0 | 15-30 game@15 | 30-45 game@30 | 45-60 game@45 | 60-75 game@60 | 75-90 game@75 | 90-100 game@90');
    // Video and audio pieces of each slice stay linked to each other.
    const v3 = Object.values(cut.clips).find((c) => c.trackId === 't1' && c.start === 45)!;
    const a3 = Object.values(cut.clips).find((c) => c.trackId === 't4' && c.start === 45)!;
    expect(v3.linkId).toBe(a3.linkId);
    expect(new Set(Object.values(cut.clips).filter((c) => c.mediaId === 'game').map((c) => c.linkId)).size).toBe(7);
  });
});

describe('titles', () => {
  it('has the presets the spec asks for', () => {
    expect(TEXT_PRESETS.map((p) => p.name)).toEqual(expect.arrayContaining(['Big Title', 'Lower Third', 'Subscribe Callout', 'Chapter Card', 'Caption Box']));
    expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(TEXT_PRESETS.length).toBeLessThanOrEqual(10);
  });

  it('places a title on the lowest free track above V1, adding one if needed', () => {
    const { tl, ids } = setup();
    let t = put(tl, { id: 'x', trackId: 't2', start: 0, duration: 100 });
    const r = addTitle(t, TEXT_PRESETS[0]!.text, 30, 60, {}, ids);
    expect(r.timeline.clips[r.clipId]!.trackId).toBe('t3');
    t = put(r.timeline, { id: 'y', trackId: 't3', start: 200, duration: 100 });
    t = put(t, { id: 'z', trackId: 't2', start: 200, duration: 100 });
    const r2 = addTitle(t, TEXT_PRESETS[0]!.text, 220, 30, {}, ids);
    expect(r2.timeline.tracks.filter((x) => x.kind === 'video')).toHaveLength(4);
    expect(r2.timeline.clips[r2.clipId]).toMatchObject({ mediaId: '', kind: 'video', start: 220, duration: 30 });
  });

  it('animates: fade, slide and pop in, with matching FFmpeg expressions', () => {
    const fps = 30;
    const pop = { ...DEFAULT_TEXT_STYLE, animIn: 'pop' as const, animOut: 'fade' as const };
    expect(textAnimState(pop, 0, 120, fps).alpha).toBe(0);
    expect(textAnimState(pop, 0, 120, fps).scale).toBeCloseTo(0.6, 10);
    expect(textAnimState(pop, 12, 120, fps).alpha).toBe(1);
    expect(textAnimState(pop, 12, 120, fps).scale).toBeCloseTo(1, 10);
    expect(textAnimState(pop, 6, 120, fps).scale).toBeGreaterThan(1); // overshoot
    expect(textAnimState(pop, 115, 120, fps).alpha).toBeCloseTo(1 - 4 / 9, 5);
    const slide = { ...DEFAULT_TEXT_STYLE, animIn: 'slide' as const, animOut: 'none' as const };
    expect(textAnimState(slide, 0, 120, fps).dx).toBeCloseTo(-0.06);
    expect(textAnimState(slide, 119, 120, fps)).toEqual({ alpha: 1, dx: 0, scale: 1 });
    const f = textAnimationFilters(pop, 120, fps, 1920, 1080);
    expect(f[0]).toContain("scale=w='max(2,trunc(1920*(0.6+0.4*(1+2.70158*pow(min(1,n/12)-1,3)");
    expect(f.at(-2)).toBe('fade=t=in:s=0:n=12:alpha=1');
    expect(f.at(-1)).toBe('fade=t=out:s=111:n=9:alpha=1');
    expect(textAnimationFilters({ ...DEFAULT_TEXT_STYLE, animIn: 'none', animOut: 'none' }, 60, fps, 1920, 1080)).toEqual([]);
  });
});

describe('project file v2', () => {
  it('round-trips audio, titles, transitions, music track and beats', () => {
    const { tl, ids } = setup();
    let t = put(tl, { id: 'a', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', volumeDb: -3, fadeIn: 10, denoise: 0.4 });
    t = setTransition(put(t, { id: 'b', trackId: 't4', start: 100, duration: 50, mediaId: 'm1' }), 'b', 'in', { type: 'crossfade', duration: 20 });
    t = addTitle(t, TEXT_PRESETS[1]!.text, 0, 90, {}, ids).timeline;
    t = { ...updateTrack(t, 't5', { music: true, volumeDb: -4 }), masterGainDb: 3.5, duckDb: -9, loudness: { integratedLufs: -17.5, truePeakDb: -4 } };
    const doc: ProjectDoc = { media: { m1: { ...videoMedia('m1'), beats: { music: true, confidence: 0.8, bpm: 128, beats: [0.1, 0.57], downbeats: [0.1] } } }, timeline: t };
    const text = serializeProject(doc, { id: 'p', name: 'P' }, 'C:\\P\\p.scut');
    expect(JSON.parse(text).version).toBe(PROJECT_VERSION);
    expect(parseProject(text, 'C:\\P\\p.scut', 'win32').doc).toEqual(doc);
  });

  it('opens version 1 files', () => {
    const v1 = JSON.stringify({ format: 'simplecut-project', version: 1, project: { id: 'x', name: 'Old' }, media: [], timeline: { tracks: [], clips: {} } });
    expect(parseProject(v1, null, 'win32').meta.name).toBe('Old');
  });
});

describe('export graph: phase 2', () => {
  const req = (doc: ProjectDoc, extra: Record<string, unknown> = {}) => ({
    doc,
    range: { start: 0, end: 200 },
    outputPath: 'C:/out.mp4',
    encoder: 'libx264' as const,
    tempDir: 'C:/tmp',
    ...extra,
  });
  const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60) };
  const graph = (plan: ReturnType<typeof buildExportPlan>) => plan.files.find((f) => f.path.endsWith('scut-graph.txt'))!.content;

  it('joins a dissolve with xfade using media handles', () => {
    const tl = setTransition(twoClips(), 'b', 'in', { type: 'dissolve', duration: 30 });
    const plan = buildExportPlan(req({ media, timeline: tl }));
    const g = graph(plan);
    // A plays 15 frames past its out point, B starts 15 frames before its in point.
    expect(plan.jobs[0]!.args.join(' ')).toContain('-ss 1.666667 -t 3.9 -i C:\\Media\\m1.mp4');
    expect(plan.jobs[0]!.args.join(' ')).toContain('-ss 1.166667 -t 3.9 -i C:\\Media\\m2.mp4');
    expect(g).toContain('trim=end_frame=115');
    expect(g).toContain('xfade=transition=fade:duration=1:offset=2.833333');
    expect(g).toMatch(/concat=n=1:v=1:a=0\[tv0\]/);
  });

  it('dips use fades, slides use xfade slideleft, fade-ins use alpha on upper tracks', () => {
    let tl = setTransition(twoClips(), 'b', 'in', { type: 'dipWhite', duration: 20 });
    expect(graph(buildExportPlan(req({ media, timeline: tl })))).toContain('color=c=0xEBEBEB:s=1920x1080:r=30,format=yuva420p,trim=end_frame=10,fade=t=in:s=0:n=10:alpha=1,setpts=PTS+3/TB');
    tl = setTransition(twoClips(), 'b', 'in', { type: 'slide', duration: 20 });
    expect(graph(buildExportPlan(req({ media, timeline: tl })))).toContain('xfade=transition=slideleft');
    let up = put(twoClips(), { id: 'u', trackId: 't2', start: 20, duration: 40, mediaId: 'm1' });
    up = setTransition(up, 'u', 'in', { type: 'dissolve', duration: 10 });
    expect(graph(buildExportPlan(req({ media, timeline: up })))).toContain('fade=t=in:s=0:n=10:alpha=1');
  });

  it('applies clip volume, fades, crossfades, track volume, ducking and master gain', () => {
    let tl = twoClips();
    tl = updateClips(tl, ['aa'], { volumeDb: -6, fadeIn: 15 });
    tl = setTransition(tl, 'ba', 'in', { type: 'crossfade', duration: 30 });
    tl = put(tl, { id: 's', trackId: 't5', start: 0, duration: 200, mediaId: 'm2' });
    tl = { ...updateTrack(tl, 't5', { music: true, volumeDb: -10 }), masterGainDb: 2.5 };
    const g = graph(buildExportPlan(req({ media, timeline: tl }, { duckRegions: [{ start: 1, end: 3 }] })));
    expect(g).toContain('volume=-6.00dB,afade=t=in:ss=0:ns=24000');
    expect(g).toContain('acrossfade=ns=48000:c1=qsin:c2=qsin');
    expect(g).toContain("volume=-10.00dB,volume=volume='pow(10,-12*clip(");
    expect(g).toContain('normalize=0,volume=2.50dB[aout]');
  });

  it('renders titles from their image with the animation', () => {
    const { tl, ids } = setup();
    const r = addTitle(tl, TEXT_PRESETS[0]!.text, 30, 60, { trackId: 't2' }, ids);
    const plan = buildExportPlan(req({ media: {}, timeline: r.timeline }, { textImages: { [r.clipId]: 'C:/tmp/title.png' }, range: { start: 0, end: 120 } }));
    const g = graph(plan);
    expect(plan.jobs[0]!.args.join(' ')).toContain('-loop 1 -framerate 30 -t 2.033333 -i C:/tmp/title.png');
    expect(g).toContain('format=yuva420p,scale=w=');
    expect(g).toContain('fade=t=in:s=0:n=12:alpha=1');
    expect(() => buildExportPlan(req({ media: {}, timeline: r.timeline }))).toThrow(/title/);
  });

  it('measures loudness on the audio only, before master gain', () => {
    const tl = { ...twoClips(), masterGainDb: 4 };
    const { job, files } = buildLoudnessJob({ doc: { media, timeline: tl }, range: { start: 0, end: 200 }, tempDir: 'C:/tmp' });
    expect(files[0]!.content).toContain('loudnorm=I=-14:TP=-1:LRA=11:print_format=json');
    expect(files[0]!.content).not.toContain('[vout]');
    expect(files[0]!.content).not.toContain('volume=4.00dB');
    expect(job.args).toEqual(expect.arrayContaining(['-f', 'null', '-loglevel', 'info']));
  });
});
