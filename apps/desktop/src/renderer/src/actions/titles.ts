import { TEXT_PRESETS, addTitle, defaultIds, updateClips, type Frame, type Id, type TextContent, type TextPreset } from '@simplecut/core';
import { getPlayhead } from '../state/playhead';
import { getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';

function place(text: TextContent, at: Frame, seconds: number, trackId?: Id): Id {
  const tl = getTimeline();
  const r = addTitle(tl, text, at, Math.round(seconds * tl.settings.fps), { trackId }, defaultIds);
  useProject.getState().commitTimeline('Add title', r.timeline);
  useUi.getState().select({ clipIds: [r.clipId] });
  useUi.getState().set({ inspectorOpen: true, inspectorTab: 'properties' });
  return r.clipId;
}

/** Adds a preset title at the playhead (or a drop position) above the footage. */
export function addPresetTitle(preset: TextPreset, at = getPlayhead(), trackId?: Id): Id {
  return place(preset.text, at, preset.seconds, trackId);
}

/** T tool: a title where you clicked in the program monitor, ready to type into. */
export function addTitleAt(x: number, y: number): void {
  const base = TEXT_PRESETS[0]!.text;
  place({ ...base, content: 'Your Title', x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), size: 110 }, getPlayhead(), 3);
  useUi.getState().set({ tool: 'select' });
  // Let the inspector mount, then focus its text box.
  setTimeout(() => window.dispatchEvent(new Event('scut:edit-title')), 50);
}

/** Changes a title's text or style. */
export function updateTitle(clipId: Id, patch: Partial<TextContent>, label = 'Edit title'): void {
  const tl = getTimeline();
  const c = tl.clips[clipId];
  if (!c?.text) return;
  useProject.getState().commitTimeline(label, updateClips(tl, [clipId], { text: { ...c.text, ...patch } }));
}

/** Restyles a title with a preset, keeping what it says. */
export function applyPresetStyle(clipId: Id, preset: TextPreset): void {
  const c = getTimeline().clips[clipId];
  if (!c?.text) return;
  updateTitle(clipId, { ...preset.text, content: c.text.content }, `Style: ${preset.name}`);
}

