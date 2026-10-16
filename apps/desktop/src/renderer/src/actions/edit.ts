import {
  addMarker,
  clearInOut,
  closeGap,
  cutAllTracks,
  defaultIds,
  deleteClips,
  expandSelection,
  extractRange,
  insertEdit,
  liftRange,
  markedRange,
  mediaUsageCount,
  nextEditPoint,
  overwriteEdit,
  pasteClips,
  prevEditPoint,
  razorClips,
  removeMarker,
  removeMedia,
  rippleDeleteClips,
  rippleTrimToPlayhead,
  setInPoint,
  setOutPoint,
  timelineDuration,
  toggleGroup,
  toggleLink,
  type Frame,
  type PlacementTracks,
  type SourceSelection,
  type Timeline,
} from '@simplecut/core';
import { api, type DragSource } from '../lib/api';
import { programEngine } from '../playback/engine';
import { getPlayhead, setPlayhead } from '../state/playhead';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useSource } from '../state/source';
import { MAX_PX_PER_FRAME, MIN_PX_PER_FRAME, useUi, type Tool } from '../state/ui';

const ids = defaultIds;
const ui = () => useUi.getState();
const toast = (text: string, kind?: 'info' | 'error') => ui().toast(text, kind);

function commit(label: string, next: Timeline): boolean {
  if (next === getTimeline()) return false;
  useProject.getState().commitTimeline(label, next);
  pruneSelection();
  return true;
}

/** Drops selected ids that no longer exist (after edits, undo, redo). */
export function pruneSelection(): void {
  const { selection, select } = ui();
  const { clips, markers } = getTimeline();
  const media = getDoc().media;
  const clipIds = selection.clipIds.filter((id) => clips[id]);
  const markerId = selection.markerId && markers.some((m) => m.id === selection.markerId) ? selection.markerId : null;
  const mediaIds = selection.mediaIds.filter((id) => media[id]);
  if (clipIds.length !== selection.clipIds.length || markerId !== selection.markerId || mediaIds.length !== selection.mediaIds.length) {
    select({ ...selection, clipIds, markerId, mediaIds });
  }
}

/** Moves the program playhead (through the engine so playback stays in sync). */
export function seekProgram(frame: Frame): void {
  const engine = programEngine();
  if (engine) engine.seek(frame);
  else setPlayhead(frame);
}

// ---------------------------------------------------------------------------
// Insert / overwrite / drag-and-drop
// ---------------------------------------------------------------------------

function sourceSelection(): SourceSelection | null {
  const s = useSource.getState();
  if (!s.mediaId || !getDoc().media[s.mediaId]) return null;
  return { mediaId: s.mediaId, inSec: s.inSec ?? 0, outSec: s.outSec, video: s.video, audio: s.audio };
}

/** `,` / `.`: places the source monitor's marked range at the playhead on the targeted tracks. */
export function placeFromSource(mode: 'insert' | 'overwrite'): void {
  const sel = sourceSelection();
  if (!sel) return toast('Open a clip in the Source monitor first (double-click it in the Media bin).');
  // Like Premiere, insert/overwrite from the keyboard moves the playhead to the end of the new material.
  placeSelection(sel, getPlayhead(), mode, undefined, true);
}

/** Places media on the timeline. Returns the end frame of the new material, or null if nothing was placed. */
export function placeSelection(
  sel: SourceSelection | DragSource,
  at: Frame,
  mode: 'insert' | 'overwrite',
  override?: Partial<PlacementTracks>,
  movePlayhead = false,
): Frame | null {
  const doc = getDoc();
  const media = doc.media[sel.mediaId];
  if (!media) return null;
  const edit = mode === 'insert' ? insertEdit : overwriteEdit;
  const r = edit(doc.timeline, media, sel, at, ids, override);
  if (!r.range) {
    toast('Nothing was placed. Check the V/A source toggles and that a target track (V1, A1…) is on and unlocked.');
    return null;
  }
  const before = doc.timeline.settings;
  commit(mode === 'insert' ? 'Insert' : 'Overwrite', r.timeline);
  const after = r.timeline.settings;
  if (!before.locked && after.locked) toast(`Timeline set to ${after.format === '4k' ? '4K' : after.format === 'vertical' ? 'vertical 9:16' : '1080p'} at ${after.fps} fps to match your first clip.`);
  if (movePlayhead) seekProgram(r.range.end);
  return r.range.end;
}

/** The preview of a drop, without committing (used while dragging over the timeline). */
export function previewPlacement(src: DragSource, at: Frame, mode: 'insert' | 'overwrite', override: Partial<PlacementTracks>): Timeline | null {
  const doc = getDoc();
  const media = doc.media[src.mediaId];
  if (!media) return null;
  const edit = mode === 'insert' ? insertEdit : overwriteEdit;
  const r = edit(doc.timeline, media, src, at, ids, override);
  return r.range ? r.timeline : null;
}

// ---------------------------------------------------------------------------
// Cutting and removing
// ---------------------------------------------------------------------------

export function liftMarked(): void {
  const range = markedRange(getTimeline());
  if (!range) return toast('Mark In (I) and Out (O) on the timeline first.');
  commit('Lift', liftRange(getTimeline(), range, ids));
}

export function extractMarked(): void {
  const range = markedRange(getTimeline());
  if (!range) return toast('Mark In (I) and Out (O) on the timeline first.');
  if (commit('Extract', extractRange(getTimeline(), range, ids))) seekProgram(range.start);
}

/** Razor tool click. Linked partners are cut too unless Alt; Shift cuts every track. */
export function razorAt(clipId: string, frame: Frame, opts: { allTracks?: boolean; linkedToo?: boolean } = {}): void {
  const tl = getTimeline();
  if (opts.allTracks) {
    commit('Razor (all tracks)', cutAllTracks(tl, frame, ids));
    return;
  }
  const targets = opts.linkedToo === false ? [clipId] : expandSelection(tl, [clipId], { grouped: false });
  commit('Razor', razorClips(tl, targets, frame, ids));
}

/** Ctrl+K */
export function cutAtPlayhead(): void {
  if (!commit('Add edit', cutAllTracks(getTimeline(), getPlayhead(), ids))) toast('Nothing to cut at the playhead.');
}

/** Q (start) / W (end) */
export function rippleTrimToPlayheadCmd(side: 'start' | 'end'): void {
  const r = rippleTrimToPlayhead(getTimeline(), getPlayhead(), side, ids);
  if (!r) return toast(side === 'start' ? 'Put the playhead inside a clip to trim its start (Q).' : 'Put the playhead inside a clip to trim its end (W).');
  commit(side === 'start' ? 'Ripple trim start' : 'Ripple trim end', r.timeline);
  seekProgram(r.playhead);
}

/** Delete/Backspace (ripple by default) and Shift+Delete (leave gap). */
export function deleteSelection(forceGap = false): void {
  const { selection, focus, prefs } = ui();
  const tl = getTimeline();
  if (focus === 'bin' && selection.mediaIds.length) {
    void removeMediaItems(selection.mediaIds);
    return;
  }
  if (selection.markerId) {
    commit('Delete marker', removeMarker(tl, selection.markerId));
    return;
  }
  if (selection.gap) {
    if (forceGap) return;
    commit('Close gap', closeGap(tl, selection.gap, ids));
    ui().select({});
    return;
  }
  if (!selection.clipIds.length) return;
  const ripple = prefs.rippleDelete && !forceGap;
  commit(ripple ? 'Ripple delete' : 'Delete', ripple ? rippleDeleteClips(tl, selection.clipIds, ids) : deleteClips(tl, selection.clipIds));
  ui().select({});
}

async function removeMediaItems(mediaIds: string[]): Promise<void> {
  const doc = getDoc();
  const used = mediaIds.reduce((n, id) => n + mediaUsageCount(doc, id), 0);
  if (used > 0) {
    const r = await api.dialogs.confirm({
      message: `Remove ${mediaIds.length === 1 ? 'this media' : `${mediaIds.length} media items`} from the project?`,
      detail: `${used} clip${used === 1 ? '' : 's'} on the timeline use it and will be removed too. You can undo this.`,
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r !== 0) return;
  }
  const s = useSource.getState();
  if (s.mediaId && mediaIds.includes(s.mediaId)) s.load(null);
  useProject.getState().commit('Remove media', removeMedia(getDoc(), mediaIds));
  ui().select({});
}

// ---------------------------------------------------------------------------
// Link, group, markers, In/Out
// ---------------------------------------------------------------------------

export function toggleLinkSelection(): void {
  const { clipIds } = ui().selection;
  if (!clipIds.length) return toast('Select clips to link or unlink (Ctrl+L).');
  const tl = getTimeline();
  const next = toggleLink(tl, clipIds, ids);
  const unlinked = clipIds.some((id) => tl.clips[id]?.linkId && !next.clips[id]?.linkId);
  if (commit(unlinked ? 'Unlink' : 'Link', next)) toast(unlinked ? 'Unlinked — video and audio now move separately.' : 'Linked.');
}

export function toggleGroupSelection(): void {
  const { clipIds } = ui().selection;
  if (!clipIds.length) return toast('Select clips to group or ungroup (Ctrl+G).');
  const tl = getTimeline();
  const next = toggleGroup(tl, clipIds, ids);
  const ungrouped = clipIds.some((id) => tl.clips[id]?.groupId && !next.clips[id]?.groupId);
  if (commit(ungrouped ? 'Ungroup' : 'Group', next)) toast(ungrouped ? 'Ungrouped.' : 'Grouped — these clips now select and move together.');
}

export function addMarkerAtPlayhead(): void {
  const tl = getTimeline();
  const frame = getPlayhead();
  const existing = tl.markers.find((m) => m.frame === frame);
  if (existing) {
    ui().select({ markerId: existing.id });
    return;
  }
  const next = addMarker(tl, frame, ids);
  if (commit('Add marker', next)) {
    const m = next.markers.find((x) => x.frame === frame);
    if (m) ui().select({ markerId: m.id });
  }
}

export function markTimeline(which: 'in' | 'out'): void {
  const tl = getTimeline();
  commit(which === 'in' ? 'Mark In' : 'Mark Out', which === 'in' ? setInPoint(tl, getPlayhead()) : setOutPoint(tl, getPlayhead()));
}

export function clearTimelineMarks(): void {
  commit('Clear In/Out', clearInOut(getTimeline()));
}

// ---------------------------------------------------------------------------
// Clipboard and selection
// ---------------------------------------------------------------------------

export function copySelection(): void {
  const tl = getTimeline();
  const clips = ui().selection.clipIds.map((id) => tl.clips[id]).filter((c) => c !== undefined);
  if (!clips.length) return;
  ui().set({ clipboard: clips });
  toast(`Copied ${clips.length} clip${clips.length === 1 ? '' : 's'}. Ctrl+V pastes at the playhead.`);
}

export function pasteAtPlayhead(): void {
  const { clipboard } = ui();
  if (!clipboard.length) return;
  commit('Paste', pasteClips(getTimeline(), clipboard, getPlayhead(), ids));
}

export function selectAll(): void {
  ui().select({ clipIds: Object.keys(getTimeline().clips) });
}

// ---------------------------------------------------------------------------
// Navigation, zoom, tools
// ---------------------------------------------------------------------------

export function goToEdit(dir: -1 | 1): void {
  const tl = getTimeline();
  const f = dir < 0 ? prevEditPoint(tl, getPlayhead()) : nextEditPoint(tl, getPlayhead());
  if (f != null) seekProgram(f);
}

export function goToEnd(which: 'start' | 'end'): void {
  seekProgram(which === 'start' ? 0 : timelineDuration(getTimeline()));
}

/** Zoom requests are handled by the timeline (it knows the viewport); this just signals. */
type ZoomListener = (z: 'in' | 'out' | 'fit') => void;
let zoomListener: ZoomListener | null = null;
export const onZoomRequest = (l: ZoomListener | null) => {
  zoomListener = l;
};
export function zoom(z: 'in' | 'out' | 'fit'): void {
  if (zoomListener) zoomListener(z);
  else {
    const px = ui().pxPerFrame;
    ui().set({ pxPerFrame: Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, z === 'in' ? px * 1.5 : px / 1.5)) });
  }
}

export function setTool(tool: Tool): void {
  ui().set({ tool });
}

export function toggleSnapping(): void {
  const snapping = !ui().snapping;
  ui().set({ snapping });
  toast(snapping ? 'Snapping on' : 'Snapping off');
}

export function undoCmd(): void {
  const p = useProject.getState();
  const entry = p.history.entries[p.history.index];
  if (p.history.index === 0) return;
  p.undo();
  ui().set({ preview: null });
  pruneSelection();
  if (entry) toast(`Undo: ${entry.label}`);
}

export function redoCmd(): void {
  const p = useProject.getState();
  if (p.history.index >= p.history.entries.length - 1) return;
  p.redo();
  ui().set({ preview: null });
  pruneSelection();
  const entry = useProject.getState().history.entries[useProject.getState().history.index];
  if (entry) toast(`Redo: ${entry.label}`);
}
