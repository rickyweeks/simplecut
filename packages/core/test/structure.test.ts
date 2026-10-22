import { describe, expect, it } from 'vitest';
import {
  annotateHistory,
  addMarker,
  addTrack,
  blackGaps,
  canRedo,
  canUndo,
  changeSettings,
  clearInOut,
  createHistory,
  currentState,
  expandSelection,
  formatTimecode,
  gapAt,
  jumpTo,
  markedRange,
  nextEditPoint,
  parseTimecode,
  prevEditPoint,
  pushHistory,
  redo,
  removeMarker,
  removeTrack,
  setInPoint,
  setOutPoint,
  snapEdges,
  snapFrame,
  snapTargets,
  toggleGroup,
  toggleLink,
  trackGaps,
  trackLabel,
  undo,
  updateMarker,
  updateTrack,
  videoTracks,
  isTrackAudible,
} from '../src';
import { layout, put, setup } from './helpers';

describe('tracks', () => {
  it('adds video tracks on top and audio tracks at the bottom', () => {
    const { tl, ids } = setup();
    const r = addTrack(addTrack(tl, 'video', ids), 'audio', ids);
    expect(r.tracks.map((t) => trackLabel(r, t.id))).toEqual(['V1', 'V2', 'V3', 'V4', 'A1', 'A2', 'A3', 'A4']);
    expect(videoTracks(r)).toHaveLength(4);
  });

  it('removes only empty tracks and clears targets pointing at them', () => {
    const { tl } = setup();
    const withClip = put(tl, { id: 'x', trackId: 't2', start: 0, duration: 10 });
    expect(removeTrack(withClip, 't2')).toBe(withClip);
    const r = removeTrack(tl, 't1');
    expect(r.tracks).toHaveLength(5);
    expect(r.targetVideoTrackId).toBeNull();
  });

  it('mute and solo decide what is audible', () => {
    const { tl } = setup();
    const a = (t: typeof tl, id: string) => isTrackAudible(t, t.tracks.find((x) => x.id === id)!);
    expect(a(tl, 't4')).toBe(true);
    const muted = updateTrack(tl, 't4', { muted: true });
    expect(a(muted, 't4')).toBe(false);
    const solo = updateTrack(tl, 't5', { solo: true });
    expect(a(solo, 't4')).toBe(false);
    expect(a(solo, 't5')).toBe(true);
  });
});

describe('link (Ctrl+L) and group (Ctrl+G)', () => {
  it('unlinks a linked pair and links a selection', () => {
    const { tl, ids } = setup();
    let t = put(tl, { id: 'v', trackId: 't1', start: 0, duration: 10, linkId: 'L' });
    t = put(t, { id: 'a', trackId: 't4', start: 0, duration: 10, linkId: 'L' });
    const unlinked = toggleLink(t, ['v'], ids);
    expect(unlinked.clips.v!.linkId).toBeUndefined();
    expect(unlinked.clips.a!.linkId).toBeUndefined();
    const relinked = toggleLink(unlinked, ['v', 'a'], ids);
    expect(relinked.clips.v!.linkId).toBeTruthy();
    expect(relinked.clips.v!.linkId).toBe(relinked.clips.a!.linkId);
  });

  it('groups and ungroups; selection expands through groups and links', () => {
    const { tl, ids } = setup();
    let t = put(tl, { id: 'v', trackId: 't1', start: 0, duration: 10, linkId: 'L' });
    t = put(t, { id: 'a', trackId: 't4', start: 0, duration: 10, linkId: 'L' });
    t = put(t, { id: 'title', trackId: 't2', start: 0, duration: 10 });
    const grouped = toggleGroup(t, ['v', 'title'], ids);
    expect(expandSelection(grouped, ['title']).sort()).toEqual(['a', 'title', 'v']);
    expect(expandSelection(grouped, ['title'], { linked: false }).sort()).toEqual(['title', 'v']);
    expect(expandSelection(grouped, ['v'], { grouped: false, linked: false })).toEqual(['v']);
    const ungrouped = toggleGroup(grouped, ['title'], ids);
    expect(ungrouped.clips.v!.groupId).toBeUndefined();
    expect(ungrouped.clips.v!.linkId).toBe('L');
  });
});

describe('markers and In/Out', () => {
  it('adds one marker per frame, edits and removes it', () => {
    const { tl, ids } = setup();
    const r = addMarker(addMarker(tl, 30, ids), 10, ids, { label: 'Intro', color: 'red' });
    expect(r.markers.map((m) => m.frame)).toEqual([10, 30]);
    expect(addMarker(r, 30, ids)).toBe(r);
    const id = r.markers[0]!.id;
    const edited = updateMarker(r, id, { label: 'Hook', chapter: true });
    expect(edited.markers[0]).toMatchObject({ label: 'Hook', chapter: true, color: 'red' });
    expect(removeMarker(edited, id).markers).toHaveLength(1);
  });

  it('In/Out are inclusive and clear each other when crossed', () => {
    const { tl } = setup();
    const t = put(tl, { id: 'x', trackId: 't1', start: 0, duration: 300 });
    expect(markedRange(t)).toBeNull();
    const marked = setOutPoint(setInPoint(t, 30), 59);
    expect(markedRange(marked)).toEqual({ start: 30, end: 60 });
    expect(markedRange(setInPoint(t, 100))).toEqual({ start: 100, end: 300 });
    expect(setInPoint(marked, 80).outPoint).toBeNull();
    expect(setOutPoint(marked, 10).inPoint).toBeNull();
    expect(markedRange(clearInOut(marked))).toBeNull();
  });
});

describe('settings', () => {
  it('changing the frame rate rescales every position', () => {
    const { tl, ids } = setup();
    let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 30, sourceIn: 15 });
    t = put(t, { id: 'b', trackId: 't1', start: 30, duration: 45 });
    t = addMarker({ ...t, inPoint: 30, outPoint: 74 }, 60, ids);
    const r = changeSettings(t, { fps: 60 });
    expect(layout(r).V1).toBe('0-60 m1@30 | 60-150 m1@0');
    expect(r.markers[0]!.frame).toBe(120);
    expect([r.inPoint, r.outPoint]).toEqual([60, 148]);
    expect(r.settings).toMatchObject({ fps: 60, locked: true });
  });
});

describe('queries', () => {
  it('finds edit points, gaps and black frames', () => {
    const { tl } = setup();
    let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100 });
    t = put(t, { id: 'b', trackId: 't1', start: 150, duration: 50 });
    t = put(t, { id: 'c', trackId: 't2', start: 120, duration: 10 });
    t = put(t, { id: 'm', trackId: 't5', start: 0, duration: 300 });
    expect(prevEditPoint(t, 150)).toBe(130);
    expect(nextEditPoint(t, 100)).toBe(120);
    expect(nextEditPoint(t, 300)).toBeNull();
    expect(trackGaps(t, 't1')).toEqual([
      { start: 100, end: 150 },
      { start: 200, end: 300 },
    ]);
    expect(gapAt(t, 't1', 110)).toEqual({ start: 100, end: 150 });
    expect(gapAt(t, 't1', 50)).toBeNull();
    // V2 covers 120-130, so black frames are 100-120, 130-150 and 200-300.
    expect(blackGaps(t)).toEqual([
      { start: 100, end: 120 },
      { start: 130, end: 150 },
      { start: 200, end: 300 },
    ]);
    expect(blackGaps(updateTrack(t, 't2', { hidden: true }))).toEqual([
      { start: 100, end: 150 },
      { start: 200, end: 300 },
    ]);
  });
});

describe('snapping', () => {
  it('snaps to playhead, clip edges, markers and In/Out', () => {
    const { tl, ids } = setup();
    let t = put(tl, { id: 'a', trackId: 't1', start: 0, duration: 100 });
    t = put(t, { id: 'b', trackId: 't1', start: 200, duration: 50 });
    t = addMarker(t, 170, ids);
    const targets = snapTargets(t, { playhead: 130, exclude: ['b'] });
    expect(targets).toEqual([0, 100, 130, 170]);
    expect(snapFrame(targets, 133, 5)).toBe(130);
    expect(snapFrame(targets, 150, 5)).toBeNull();
    // A 50-frame block dragged to 103: its start snaps to 100.
    expect(snapEdges(targets, [103, 153], 5)).toEqual({ correction: -3, at: 100 });
    // Its end lands near the marker.
    expect(snapEdges(targets, [118, 168], 5)).toEqual({ correction: 2, at: 170 });
  });
});

describe('undo / redo history', () => {
  it('records labelled states, undoes, redoes and jumps', () => {
    let h = createHistory('s0', 'Open');
    h = pushHistory(h, 'Insert', 's1');
    h = pushHistory(h, 'Razor', 's2');
    expect(h.entries.map((e) => e.label)).toEqual(['Open', 'Insert', 'Razor']);
    h = undo(h);
    expect(currentState(h)).toBe('s1');
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(currentState(h)).toBe('s2');
    h = jumpTo(h, 0);
    expect(currentState(h)).toBe('s0');
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
  });

  it('a new edit after undo discards the redo branch; unchanged states are not recorded', () => {
    let h = createHistory('s0');
    h = pushHistory(h, 'A', 's1');
    h = undo(h);
    h = pushHistory(h, 'B', 's2');
    expect(h.entries.map((e) => e.state)).toEqual(['s0', 's2']);
    expect(pushHistory(h, 'noop', 's2')).toBe(h);
    expect(new Set(h.entries.map((e) => e.id)).size).toBe(2);
  });

  it('annotates every snapshot without adding an undo step', () => {
    let h = createHistory({ n: 0 });
    h = pushHistory(h, 'A', { n: 1 });
    h = pushHistory(h, 'B', { n: 2 });
    h = undo(h);
    const tagged = annotateHistory(h, (s) => (s.n > 0 ? { ...s, tag: true } : s));
    expect(tagged.entries.map((e) => e.label)).toEqual(['Start', 'A', 'B']);
    expect(tagged.entries.map((e) => (e.state as { tag?: boolean }).tag)).toEqual([undefined, true, true]);
    expect(tagged.entries[0]).toBe(h.entries[0]);
    expect(tagged.index).toBe(1);
    expect(canRedo(tagged)).toBe(true);
    expect(annotateHistory(h, (s) => s)).toBe(h);
  });

  it('is unlimited', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 5000; i++) h = pushHistory(h, `edit ${i}`, i);
    expect(h.entries).toHaveLength(5001);
    for (let i = 0; i < 5000; i++) h = undo(h);
    expect(currentState(h)).toBe(0);
  });
});

describe('timecode', () => {
  it('formats and parses HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(30 * 3661 + 7, 30)).toBe('01:01:01:07');
    expect(parseTimecode('01:01:01:07', 30)).toBe(30 * 3661 + 7);
    expect(parseTimecode('1:00', 30)).toBe(30);
    expect(parseTimecode('45', 30)).toBe(45);
    expect(parseTimecode('00:00:00:30', 30)).toBeNull();
    expect(parseTimecode('abc', 30)).toBeNull();
  });
});
