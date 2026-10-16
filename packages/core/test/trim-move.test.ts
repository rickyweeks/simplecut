import { describe, expect, it } from 'vitest';
import { edgeClips, moveClips, pasteClips, trimClips, updateTrack, type Timeline } from '../src';
import { expectValid, layout, linkGroup, put, setup, videoMedia } from './helpers';

const media = { m1: videoMedia('m1', 60), m2: videoMedia('m2', 60), m9: videoMedia('m9', 600) };

/** V1: a [0,100) m1@0, b [150,250) m2@100 (linked to A1 copies); A2: music [0,600). */
function base(): Timeline {
  const { tl } = setup();
  let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100, mediaId: 'm1', linkId: 'La' });
  t = put(t, { id: 'aa', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', linkId: 'La' });
  t = put(t, { id: 'b', trackId: 't1', start: 150, duration: 100, mediaId: 'm2', sourceIn: 100, linkId: 'Lb' });
  t = put(t, { id: 'ba', trackId: 't4', start: 150, duration: 100, mediaId: 'm2', sourceIn: 100, linkId: 'Lb' });
  t = put(t, { id: 'music', trackId: 't5', start: 0, duration: 600, mediaId: 'm9' });
  return t;
}

describe('normal trim (drag an edge)', () => {
  it('extends an end up to the next clip', () => {
    const tl = base();
    expect(layout(trimClips(tl, media, ['a'], 'end', 30)).V1).toBe('0-130 m1@0 | 150-250 m2@100');
    expect(layout(trimClips(tl, media, ['a'], 'end', 80)).V1).toBe('0-150 m1@0 | 150-250 m2@100');
  });

  it('extends a start back to the previous clip, revealing source', () => {
    const tl = base();
    expect(layout(trimClips(tl, media, ['b'], 'start', -200)).V1).toBe('0-100 m1@0 | 100-250 m2@50');
  });

  it('never shrinks a clip below one frame or past the media', () => {
    const tl = base();
    expect(layout(trimClips(tl, media, ['a'], 'start', 500)).V1).toBe('99-100 m1@99 | 150-250 m2@100');
    const alone = put(setup().tl, { id: 'x', trackId: 't1', start: 0, duration: 100, mediaId: 'm1' });
    expect(layout(trimClips(alone, media, ['x'], 'end', 5000)).V1).toBe('0-1800 m1@0');
  });

  it('trims linked partners that share the edge', () => {
    const tl = base();
    const set = edgeClips(tl, 'a', 'end').map((c) => c.id);
    expect(set.sort()).toEqual(['a', 'aa']);
    const r = trimClips(tl, media, set, 'end', -40);
    expect(layout(r)).toMatchObject({ V1: '0-60 m1@0 | 150-250 m2@100', A1: '0-60 m1@0 | 150-250 m2@100' });
    // Alt-trim: only one side.
    expect(edgeClips(tl, 'a', 'end', false).map((c) => c.id)).toEqual(['a']);
  });

  it('does nothing on locked tracks', () => {
    const tl = updateTrack(base(), 't1', { locked: true });
    expect(trimClips(tl, media, ['a'], 'end', 10)).toBe(tl);
  });
});

describe('ripple trim (Ctrl+drag an edge)', () => {
  it('shortening an end pulls later clips in; the spanning music stays', () => {
    const tl = base();
    const r = trimClips(tl, media, ['a', 'aa'], 'end', -30, { ripple: true });
    expect(layout(r)).toEqual({
      V1: '0-70 m1@0 | 120-220 m2@100',
      A1: '0-70 m1@0 | 120-220 m2@100',
      A2: '0-600 m9@0',
    });
    expectValid(r);
  });

  it('lengthening an end pushes later clips out', () => {
    const tl = base();
    const r = trimClips(tl, media, ['a', 'aa'], 'end', 80, { ripple: true });
    expect(layout(r)).toMatchObject({ V1: '0-180 m1@0 | 230-330 m2@100', A1: '0-180 m1@0 | 230-330 m2@100' });
    expectValid(r);
  });

  it('a start-edge ripple keeps the clip in place and shifts what follows', () => {
    const tl = base();
    const r = trimClips(tl, media, ['a', 'aa'], 'start', 20, { ripple: true });
    expect(layout(r)).toMatchObject({ V1: '0-80 m1@20 | 130-230 m2@100', A1: '0-80 m1@20 | 130-230 m2@100' });
  });
});

describe('move (drag clips)', () => {
  it('overwrites what it is dropped on, like Premiere', () => {
    const tl = base();
    const r = moveClips(tl, ['b', 'ba'], -100, 0);
    expect(layout(r)).toMatchObject({ V1: '0-50 m1@0 | 50-150 m2@100', A1: '0-50 m1@0 | 50-150 m2@100' });
    expectValid(r);
  });

  it('moves linked video up and audio down together (V1→V2, A1→A2)', () => {
    const { tl } = setup();
    let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100, mediaId: 'm1', linkId: 'L' });
    t = put(t, { id: 'aa', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', linkId: 'L' });
    const r = moveClips(t, ['a', 'aa'], 10, 1);
    expect(layout(r)).toEqual({ V2: '10-110 m1@0', A2: '10-110 m1@0' });
  });

  it('clamps at frame 0 and at the outermost tracks', () => {
    const tl = base();
    expect(layout(moveClips(tl, ['b'], -1000, 0)).V1).toBe('0-100 m2@100');
    const r = moveClips(tl, ['a'], 0, 10);
    expect(layout(r).V3).toBe('0-100 m1@0');
  });

  it('Alt+drag duplicates with fresh ids and fresh links', () => {
    const tl = base();
    const r = moveClips(tl, ['a', 'aa'], 300, 0, { duplicate: true });
    expect(layout(r)).toMatchObject({ V1: '0-100 m1@0 | 150-250 m2@100 | 300-400 m1@0', A1: '0-100 m1@0 | 150-250 m2@100 | 300-400 m1@0' });
    const copy = Object.values(r.clips).find((c) => c.trackId === 't1' && c.start === 300)!;
    expect(copy.id).not.toBe('a');
    expect(copy.linkId).not.toBe('La');
    expect(linkGroup(r, copy.id)).toHaveLength(2);
    expect(linkGroup(r, 'a')).toEqual(['a', 'aa']);
  });

  it('Ctrl+drag inserts: pushes material at the drop point later on all unlocked tracks', () => {
    const tl = base();
    const r = moveClips(tl, ['b', 'ba'], -100, 0, { insert: true });
    expect(layout(r)).toMatchObject({
      V1: '0-50 m1@0 | 50-150 m2@100 | 150-200 m1@50',
      A1: '0-50 m1@0 | 50-150 m2@100 | 150-200 m1@50',
      A2: '0-50 m9@0 | 150-700 m9@50',
    });
    expectValid(r);
  });

  it('refuses to move onto or off a locked track', () => {
    const tl = updateTrack(base(), 't2', { locked: true });
    expect(moveClips(tl, ['a'], 0, 1)).toBe(tl);
    const lockedV1 = updateTrack(base(), 't1', { locked: true });
    expect(moveClips(lockedV1, ['a'], 10, 0)).toBe(lockedV1);
  });
});

describe('paste (Ctrl+V)', () => {
  it('pastes copies at the playhead on the same tracks, overwriting', () => {
    const tl = base();
    const copied = [tl.clips.a!, tl.clips.aa!];
    const r = pasteClips(tl, copied, 400);
    expect(layout(r)).toMatchObject({ V1: '0-100 m1@0 | 150-250 m2@100 | 400-500 m1@0' });
    const pasted = Object.values(r.clips).filter((c) => c.start === 400);
    expect(pasted).toHaveLength(2);
    expect(pasted[0]!.linkId).toBe(pasted[1]!.linkId);
    expect(pasted[0]!.linkId).not.toBe('La');
  });
});
