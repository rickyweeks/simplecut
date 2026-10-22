import {
  DEFAULT_GRADE,
  DEFAULT_TRANSFORM,
  addMedia,
  applyReverse,
  attributeSources,
  autoColor,
  createMediaItem,
  pasteAttributes,
  pipTransform,
  punchInTransform,
  reverseRange,
  setClipSpeed,
  sourceSpan,
  updateClips,
  updateTransforms,
  type AttributeGroup,
  type ColorGrade,
  type Corner,
  type Id,
  type MediaItem,
  type Transform,
} from '@simplecut/core';
import { api } from '../lib/api';
import { reloadLut } from '../state/luts';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { liveEdit } from './edit';
import { prepareAssets } from '../state/assets';

/**
 * Picture and timing changes on clips: transforms (and the PiP / punch-in presets), speed,
 * reverse, color (sliders, looks, LUTs, Auto Color) and Paste Attributes.
 */

const toast = (text: string, kind?: 'info' | 'error') => useUi.getState().toast(text, kind);
const commit = (label: string, tl = getTimeline()) => useProject.getState().commitTimeline(label, tl);
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/** Selected clips that have a picture (not titles). */
export function selectedVideoClipIds(): Id[] {
  const tl = getTimeline();
  return useUi.getState().selection.clipIds.filter((id) => {
    const c = tl.clips[id];
    return c && c.kind === 'video' && !c.text && getDoc().media[c.mediaId];
  });
}

// ---- Transform -------------------------------------------------------------

/** Slider / number edits: previewed live, one undo step when you stop. */
export function liveTransform(clipIds: Id[], patch: Partial<Transform>, label = 'Transform'): void {
  liveEdit(label, (tl) => updateTransforms(tl, clipIds, patch));
}

export function setTransform(clipIds: Id[], patch: Partial<Transform>, label: string): void {
  commit(label, updateTransforms(getTimeline(), clipIds, patch));
}

export function resetTransform(clipIds: Id[]): void {
  commit('Reset position and size', updateTransforms(getTimeline(), clipIds, { ...DEFAULT_TRANSFORM, zoomTo: undefined }));
}

/** Picture-in-picture: shrink the clip into a corner with a border and rounded corners. */
export function applyPip(clipIds: Id[], corner: Corner): void {
  const doc = getDoc();
  const tl = updateTransforms(doc.timeline, clipIds, (_t, c) => pipTransform(corner, doc.media[c.mediaId]!, doc.timeline.settings.format));
  commit('Picture in picture', tl);
  toast('Picture-in-picture: drag it on the Program monitor to move it, or pick another corner.');
}

export function applyPunchIn(clipIds: Id[], amount: number, smooth: boolean): void {
  commit(smooth ? 'Smooth zoom' : 'Punch-in', updateTransforms(getTimeline(), clipIds, punchInTransform(amount, smooth)));
}

// ---- Speed and reverse ---------------------------------------------------------

export function setSpeed(clipIds: Id[], speed: number): void {
  const tl = getTimeline();
  const ids = clipIds.filter((id) => tl.clips[id] && !tl.clips[id]!.text);
  if (!ids.length) return;
  commit(speed === 1 ? 'Normal speed' : `Speed ${Math.round(speed * 100)}%`, setClipSpeed(tl, ids, speed));
}

let reversing = false;

/**
 * Reverses the selected clip (and its linked sound). The first time, SimpleCut makes a
 * reversed copy of just the part of the file the clip uses; reversing again goes back.
 */
export async function reverseSelected(): Promise<void> {
  if (reversing) return;
  const tl = getTimeline();
  const doc = getDoc();
  const clip = useUi.getState().selection.clipIds.map((id) => tl.clips[id]).find((c) => c && !c.text && doc.media[c.mediaId]?.kind !== 'image');
  if (!clip) return toast('Select a video or audio clip to reverse.');
  const media = doc.media[clip.mediaId]!;
  if (media.derived) {
    const original = doc.media[media.derived.from];
    if (!original) return toast('The original file of this reversed clip is no longer in the project.', 'error');
    commit('Reverse', applyReverse(tl, clip.id, media, original));
    return toast('Playing forwards again.');
  }
  const fps = tl.settings.fps;
  const { inSec, outSec } = reverseRange(media, clip, fps);
  reversing = true;
  toast('Reversing… (making a reversed copy of this part of the clip)');
  try {
    // Reuse a copy that already covers this part of the file.
    let copy: MediaItem | undefined = Object.values(doc.media).find(
      (m) => m.derived?.from === media.id && m.derived.inSec <= inSec + 1e-6 && m.derived.outSec >= outSec - 1e-6,
    );
    if (!copy) {
      const path = await api.media.reverse(media, inSec, outSec);
      const info = await api.media.probe(path);
      copy = { ...createMediaItem(info, path, undefined, `${media.name} (reversed)`), derived: { from: media.id, op: 'reverse', inSec, outSec } };
      prepareAssets(copy);
    }
    const current = getDoc();
    const withMedia = current.media[copy.id] ? current : addMedia(current, [copy]);
    const live = withMedia.timeline.clips[clip.id];
    if (!live) return;
    useProject.getState().commit('Reverse', { ...withMedia, timeline: applyReverse(withMedia.timeline, clip.id, media, copy) });
    toast('Reversed. Reverse again to play forwards.');
  } catch (e) {
    toast(`Couldn't reverse the clip: ${errText(e)}`, 'error');
  } finally {
    reversing = false;
  }
}

/** Seconds of source a clip uses, for messages. */
export const clipSourceSeconds = (id: Id): number => {
  const c = getTimeline().clips[id];
  return c ? sourceSpan(c, c.duration) / getTimeline().settings.fps : 0;
};

// ---- Color ----------------------------------------------------------------------

const gradeOf = (id: Id): ColorGrade => getTimeline().clips[id]?.color ?? DEFAULT_GRADE;

export function liveColor(clipIds: Id[], patch: Partial<ColorGrade>): void {
  // Per clip, so each keeps its own other settings.
  liveEdit('Color', (tl) => {
    let out = tl;
    for (const id of clipIds) out = updateClips(out, [id], { color: { ...(tl.clips[id]?.color ?? DEFAULT_GRADE), ...patch } });
    return out;
  });
}

export function setColor(clipIds: Id[], patch: Partial<ColorGrade>, label: string): void {
  let tl = getTimeline();
  for (const id of clipIds) tl = updateClips(tl, [id], { color: { ...gradeOf(id), ...patch } });
  commit(label, tl);
}

export function resetColor(clipIds: Id[]): void {
  commit('Reset color', updateClips(getTimeline(), clipIds, { color: undefined }));
}

/** Auto Color: white balance, exposure and contrast from frames sampled across the clip. */
export async function autoColorCmd(clipIds: Id[]): Promise<void> {
  const tl = getTimeline();
  const doc = getDoc();
  const fps = tl.settings.fps;
  toast('Looking at the clip…');
  for (const id of clipIds) {
    const c = tl.clips[id];
    const m = c && doc.media[c.mediaId];
    if (!c || !m) continue;
    const start = c.sourceIn / fps;
    const span = m.kind === 'image' ? 0 : sourceSpan(c, c.duration) / fps;
    const times = m.kind === 'image' ? [0] : [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => start + span * f);
    try {
      const px = await api.media.colorSamples(m.path, times);
      setColor([id], autoColor(px), 'Auto Color');
    } catch (e) {
      toast(`Auto Color couldn't read "${m.name}": ${errText(e)}`, 'error');
      return;
    }
  }
  toast('Auto Color applied. Fine-tune with the sliders.');
}

/** Picks a .cube LUT (e.g. a camera's log-to-normal LUT) and applies it to the clips. */
export async function importLutCmd(clipIds: Id[]): Promise<void> {
  const path = await api.dialogs.openLut();
  if (!path) return;
  reloadLut(path);
  try {
    const lut = await api.media.readLut(path);
    const name = (path.split(/[\\/]/).pop() ?? 'LUT').replace(/\.cube$/i, '');
    setColor(clipIds, { lut: { path, name: lut.title || name } }, 'Apply LUT');
    toast(`LUT "${lut.title || name}" applied.`);
  } catch (e) {
    toast(`That LUT can't be used: ${errText(e)}`, 'error');
  }
}

// ---- Paste attributes ---------------------------------------------------------------

/** Ctrl+Alt+V: opens the Paste Attributes dialog (needs copied clips and a selection). */
export function openPasteAttributes(): void {
  const ui = useUi.getState();
  if (!ui.clipboard.length) return toast('Copy a clip first (Ctrl+C), then select clips and press Ctrl+Alt+V.');
  if (!ui.selection.clipIds.length) return toast('Select the clips to paste onto, then press Ctrl+Alt+V.');
  ui.set({ dialog: 'pasteAttributes' });
}

export function pasteAttributesCmd(groups: AttributeGroup[]): void {
  const ui = useUi.getState();
  const tl = pasteAttributes(getTimeline(), attributeSources(ui.clipboard), ui.selection.clipIds, groups);
  commit('Paste attributes', tl);
  ui.set({ dialog: null });
}
