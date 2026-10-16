import { describe, expect, it } from 'vitest';
import {
  closeGap,
  cutAllTracks,
  deleteClips,
  expandSelection,
  extractRange,
  insertEdit,
  liftRange,
  overwriteEdit,
  razorClips,
  rippleDeleteClips,
  rippleTrimToPlayhead,
  updateTrack,
  type SourceSelection,
  type Timeline,
} from '../src';
import { audioMedia, expectValid, imageMedia, layout, linkGroup, put, setup, videoMedia } from './helpers';

const m1 = videoMedia('m1', 60);
const m2 = videoMedia('m2', 60);
const sel = (mediaId: string, inSec: number, outSec: number | null, video = true, audio = true): SourceSelection => ({
  mediaId,
  inSec,
  outSec,
  video,
  audio,
});

/** Talking head a|b|c on V1+A1 (linked pairs), music bed on A2. */
function talkingHead(): { tl: Timeline; V1: string; V2: string; A1: string; A2: string } {
  const s = setup();
  let tl = s.tl;
  tl = put(tl, { id: 'a', trackId: s.V1, start: 0, duration: 100, mediaId: 'm1', linkId: 'La' });
  tl = put(tl, { id: 'aa', trackId: s.A1, start: 0, duration: 100, mediaId: 'm1', linkId: 'La' });
  tl = put(tl, { id: 'b', trackId: s.V1, start: 100, duration: 100, mediaId: 'm2', linkId: 'Lb' });
  tl = put(tl, { id: 'ba', trackId: s.A1, start: 100, duration: 100, mediaId: 'm2', linkId: 'Lb' });
  tl = put(tl, { id: 'c', trackId: s.V1, start: 200, duration: 100, mediaId: 'm3', linkId: 'Lc' });
  tl = put(tl, { id: 'ca', trackId: s.A1, start: 200, duration: 100, mediaId: 'm3', linkId: 'Lc' });
  tl = put(tl, { id: 'music', trackId: s.A2, start: 0, duration: 600, mediaId: 'm9' });
  return { tl, V1: s.V1, V2: s.V2, A1: s.A1, A2: s.A2 };
}

describe('insert (,)', () => {
  it('places linked video and audio on the targeted tracks', () => {
    const { tl, ids } = setup();
    const r = insertEdit(tl, m1, sel('m1', 1, 3), 0, ids);
    expect(layout(r.timeline)).toEqual({ V1: '0-60 m1@30', A1: '0-60 m1@30' });
    expect(r.placed).toHaveLength(2);
    expect(linkGroup(r.timeline, r.placed[0]!)).toEqual([...r.placed].sort());
    expect(r.range).toEqual({ start: 0, end: 60 });
    expectValid(r.timeline);
  });

  it('splits and pushes later material on every unlocked track', () => {
    const { tl: base, ids } = setup();
    let tl = put(base, { id: 'a', trackId: 't1', start: 0, duration: 100, mediaId: 'm1', linkId: 'L' });
    tl = put(tl, { id: 'aa', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', linkId: 'L' });
    tl = put(tl, { id: 'music', trackId: 't5', start: 0, duration: 300, mediaId: 'm9' });
    const r = insertEdit(tl, m2, sel('m2', 0, 2), 40, ids).timeline;
    expect(layout(r)).toEqual({
      V1: '0-40 m1@0 | 40-100 m2@0 | 100-160 m1@40',
      A1: '0-40 m1@0 | 40-100 m2@0 | 100-160 m1@40',
      A2: '0-40 m9@0 | 100-360 m9@40',
    });
    // Left halves keep their link; right halves are linked to each other.
    expect(linkGroup(r, 'a')).toEqual(['a', 'aa']);
    const rightV = Object.values(r.clips).find((c) => c.trackId === 't1' && c.start === 100)!;
    const rightA = Object.values(r.clips).find((c) => c.trackId === 't4' && c.start === 100)!;
    expect(rightV.linkId).toBeTruthy();
    expect(rightV.linkId).toBe(rightA.linkId);
    expect(rightV.linkId).not.toBe('L');
    expectValid(r);
  });

  it('leaves locked tracks alone', () => {
    const { tl: base, ids } = setup();
    let tl = put(base, { id: 'music', trackId: 't5', start: 0, duration: 300, mediaId: 'm9' });
    tl = updateTrack(tl, 't5', { locked: true });
    const r = insertEdit(tl, m2, sel('m2', 0, 1), 10, ids).timeline;
    expect(layout(r).A2).toBe('0-300 m9@0');
  });

  it('respects the V/A source toggles and source patching', () => {
    const { tl, ids } = setup();
    expect(layout(insertEdit(tl, m1, sel('m1', 0, 1, true, false), 0, ids).timeline)).toEqual({ V1: '0-30 m1@0' });
    expect(layout(insertEdit(tl, m1, sel('m1', 0, 1, false, true), 0, ids).timeline)).toEqual({ A1: '0-30 m1@0' });
    const untargeted = { ...tl, targetAudioTrackId: null };
    expect(layout(insertEdit(untargeted, m1, sel('m1', 0, 1), 0, ids).timeline)).toEqual({ V1: '0-30 m1@0' });
  });

  it('places B-roll video only on V2 when overridden (drag to a track)', () => {
    const { tl, ids } = setup();
    const r = overwriteEdit(tl, m2, sel('m2', 0, 2, true, false), 30, ids, { videoTrackId: 't2' }).timeline;
    expect(layout(r)).toEqual({ V2: '30-90 m2@0' });
  });

  it('clamps the source range to the media length', () => {
    const { tl, ids } = setup();
    const short = videoMedia('s', 2); // 60 frames
    const r = insertEdit(tl, short, sel('s', 1, 10), 0, ids).timeline;
    expect(layout(r).V1).toBe('0-30 s@30');
  });

  it('gives still images a default length and audio files only an audio clip', () => {
    const { tl, ids } = setup();
    expect(layout(insertEdit(tl, imageMedia('img'), sel('img', 0, null), 0, ids).timeline)).toEqual({ V1: '0-150 img@0' });
    expect(layout(insertEdit(tl, audioMedia('song'), sel('song', 0, 4), 0, ids).timeline)).toEqual({ A1: '0-120 song@0' });
  });
});

describe('auto-match timeline settings', () => {
  it('adopts the first video clip format and frame rate (and rescales the drop point)', () => {
    const { tl, ids } = setup();
    const uhd = videoMedia('u', 10, { width: 3840, height: 2160, fps: 59.94, avgFps: 59.94 });
    const r = insertEdit(tl, uhd, sel('u', 0, 1), 30, ids).timeline;
    expect(r.settings).toMatchObject({ format: '4k', fps: 60, locked: true });
    expect(layout(r).V1).toBe('60-120 u@0');
  });

  it('detects vertical footage', () => {
    const { tl, ids } = setup();
    const phone = videoMedia('p', 10, { width: 1080, height: 1920 });
    expect(insertEdit(tl, phone, sel('p', 0, 1), 0, ids).timeline.settings.format).toBe('vertical');
  });

  it('does not lock settings for audio-only media, nor change a non-empty timeline', () => {
    const { tl, ids } = setup();
    const withSong = insertEdit(tl, audioMedia('song'), sel('song', 0, 1), 0, ids).timeline;
    expect(withSong.settings.locked).toBe(false);
    const uhd = videoMedia('u', 10, { width: 3840, height: 2160, fps: 60 });
    expect(insertEdit(withSong, uhd, sel('u', 0, 1), 0, ids).timeline.settings).toMatchObject({ format: '1080p', fps: 30 });
  });
});

describe('overwrite (.)', () => {
  it('replaces material on the target tracks only', () => {
    const { tl, ids } = setup();
    let base = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100, mediaId: 'm1', linkId: 'L' });
    base = put(base, { id: 'aa', trackId: 't4', start: 0, duration: 100, mediaId: 'm1', linkId: 'L' });
    base = put(base, { id: 'music', trackId: 't5', start: 0, duration: 300, mediaId: 'm9' });
    const r = overwriteEdit(base, m2, sel('m2', 0, 1), 40, ids).timeline;
    expect(layout(r)).toEqual({
      V1: '0-40 m1@0 | 40-70 m2@0 | 70-100 m1@70',
      A1: '0-40 m1@0 | 40-70 m2@0 | 70-100 m1@70',
      A2: '0-300 m9@0',
    });
    expectValid(r);
  });
});

describe('ripple delete', () => {
  it('closes the gap on every track that is empty there, keeping the music bed intact', () => {
    const { tl, V2 } = talkingHead();
    const withBroll = put(tl, { id: 'broll', trackId: V2, start: 250, duration: 30, mediaId: 'm5' });
    const r = rippleDeleteClips(withBroll, expandSelection(withBroll, ['b']));
    expect(layout(r)).toEqual({
      V1: '0-100 m1@0 | 100-200 m3@0',
      V2: '150-180 m5@0',
      A1: '0-100 m1@0 | 100-200 m3@0',
      A2: '0-600 m9@0',
    });
    expectValid(r);
  });

  it('handles several selected clips at different times', () => {
    const { tl } = talkingHead();
    const r = rippleDeleteClips(tl, expandSelection(tl, ['a', 'c']));
    expect(layout(r)).toMatchObject({ V1: '0-100 m2@0', A1: '0-100 m2@0' });
  });

  it('Shift+Delete leaves a gap', () => {
    const { tl } = talkingHead();
    const r = deleteClips(tl, expandSelection(tl, ['b']));
    expect(layout(r)).toMatchObject({ V1: '0-100 m1@0 | 200-300 m3@0', A1: '0-100 m1@0 | 200-300 m3@0' });
  });

  it('closes a selected gap', () => {
    const { tl } = talkingHead();
    const gapped = deleteClips(tl, ['b', 'ba']);
    const r = closeGap(gapped, { start: 100, end: 200 });
    expect(layout(r)).toMatchObject({ V1: '0-100 m1@0 | 100-200 m3@0', A1: '0-100 m1@0 | 100-200 m3@0', A2: '0-600 m9@0' });
  });

  it('never touches locked tracks', () => {
    const { tl, A1 } = talkingHead();
    const locked = updateTrack(tl, A1, { locked: true });
    const r = rippleDeleteClips(locked, ['b', 'ba']);
    expect(layout(r)).toMatchObject({ V1: '0-100 m1@0 | 100-200 m3@0', A1: '0-100 m1@0 | 100-200 m2@0 | 200-300 m3@0' });
  });
});

describe('lift (;) and extract (\')', () => {
  it('lift removes the range from all unlocked tracks and leaves a gap', () => {
    const { tl } = talkingHead();
    const r = liftRange(tl, { start: 50, end: 150 });
    expect(layout(r)).toEqual({
      V1: '0-50 m1@0 | 150-200 m2@50 | 200-300 m3@0',
      A1: '0-50 m1@0 | 150-200 m2@50 | 200-300 m3@0',
      A2: '0-50 m9@0 | 150-600 m9@150',
    });
    expectValid(r);
  });

  it('extract removes the range and closes it everywhere', () => {
    const { tl } = talkingHead();
    const marked = { ...tl, inPoint: 50, outPoint: 149 };
    const r = extractRange(marked, { start: 50, end: 150 });
    expect(layout(r)).toEqual({
      V1: '0-50 m1@0 | 50-100 m2@50 | 100-200 m3@0',
      A1: '0-50 m1@0 | 50-100 m2@50 | 100-200 m3@0',
      A2: '0-50 m9@0 | 50-500 m9@150',
    });
    expect(r.inPoint).toBeNull();
    expect(r.outPoint).toBeNull();
    expectValid(r);
  });
});

describe('razor (C) and cut at playhead (Ctrl+K)', () => {
  it('razor splits a clip and its linked partner, relinking the halves', () => {
    const { tl } = talkingHead();
    const r = razorClips(tl, expandSelection(tl, ['a']), 40);
    expect(layout(r)).toMatchObject({ V1: '0-40 m1@0 | 40-100 m1@40 | 100-200 m2@0 | 200-300 m3@0' });
    expect(layout(r).A1).toBe('0-40 m1@0 | 40-100 m1@40 | 100-200 m2@0 | 200-300 m3@0');
    const rightV = Object.values(r.clips).find((c) => c.trackId === 't1' && c.start === 40)!;
    const rightA = Object.values(r.clips).find((c) => c.trackId === 't4' && c.start === 40)!;
    expect(rightV.linkId).toBe(rightA.linkId);
    expect(rightV.linkId).not.toBe(r.clips.a!.linkId);
    expect(r.clips.a!.linkId).toBe(r.clips.aa!.linkId);
    expect(layout(r).A2).toBe('0-600 m9@0');
  });

  it('razor on an edit point does nothing', () => {
    const { tl } = talkingHead();
    expect(razorClips(tl, ['a'], 100)).toBe(tl);
  });

  it('Ctrl+K cuts every unlocked track at the playhead', () => {
    const { tl, A2 } = talkingHead();
    const r = cutAllTracks(tl, 150);
    expect(layout(r).V1).toBe('0-100 m1@0 | 100-150 m2@0 | 150-200 m2@50 | 200-300 m3@0');
    expect(layout(r).A2).toBe('0-150 m9@0 | 150-600 m9@150');
    const lockedMusic = cutAllTracks(updateTrack(tl, A2, { locked: true }), 150);
    expect(layout(lockedMusic).A2).toBe('0-600 m9@0');
  });
});

describe('Q / W ripple trims to the playhead', () => {
  it('Q trims the start of the clip under the playhead and moves the playhead back', () => {
    const { tl } = talkingHead();
    const r = rippleTrimToPlayhead(tl, 130, 'start')!;
    expect(r.playhead).toBe(100);
    expect(layout(r.timeline)).toEqual({
      V1: '0-100 m1@0 | 100-170 m2@30 | 170-270 m3@0',
      A1: '0-100 m1@0 | 100-170 m2@30 | 170-270 m3@0',
      A2: '0-600 m9@0',
    });
    expectValid(r.timeline);
  });

  it('W trims the end of the clip under the playhead', () => {
    const { tl } = talkingHead();
    const r = rippleTrimToPlayhead(tl, 130, 'end')!;
    expect(r.playhead).toBe(130);
    expect(layout(r.timeline)).toMatchObject({
      V1: '0-100 m1@0 | 100-130 m2@0 | 130-230 m3@0',
      A1: '0-100 m1@0 | 100-130 m2@0 | 130-230 m3@0',
      A2: '0-600 m9@0',
    });
  });

  it('Q exactly on a cut does nothing (and never trims the music instead)', () => {
    const { tl } = talkingHead();
    expect(rippleTrimToPlayhead(tl, 100, 'start')).toBeNull();
  });

  it('falls back to other tracks when the targeted ones are empty under the playhead', () => {
    const { tl: base, ids } = setup();
    const tl = put(base, { id: 'x', trackId: 't2', start: 0, duration: 100, mediaId: 'm1' });
    const r = rippleTrimToPlayhead(tl, 40, 'end', ids)!;
    expect(layout(r.timeline)).toEqual({ V2: '0-40 m1@0' });
  });
});
