import { FORMATS, captionsToSrt, captionsTrack, chapterList, clipsOnTrack, type ProjectDoc, type Range } from '@simplecut/core';
import { api } from '../lib/api';
import { clipImagesFor } from '../render/picture';
import { getPlayhead } from '../state/playhead';
import { getDoc, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { textPng } from '../text/renderText';
import { flushLiveEdit } from './edit';

/**
 * Getting things out of SimpleCut besides the video: thumbnails, chapters and captions,
 * plus the images the export needs from the UI (titles, rounded corners, borders).
 */

const toast = (text: string, kind?: 'info' | 'error') => useUi.getState().toast(text, kind);

/** Titles, masks and borders for clips in a range, drawn at the output size. */
export async function exportImages(doc: ProjectDoc, range: Range, size: { width: number; height: number } = FORMATS[doc.timeline.settings.format]) {
  const textImages: Record<string, Uint8Array> = {};
  for (const c of Object.values(doc.timeline.clips)) {
    if (c.text && c.start < range.end && c.start + c.duration > range.start) textImages[c.id] = await textPng(c.text, size.width, size.height);
  }
  const clipImages = await clipImagesFor(doc.timeline, doc.media, range, size);
  return { textImages, clipImages };
}

const baseName = () => useProject.getState().meta.name.replace(/[\\/:*?"<>|]/g, '_') || 'Untitled';

/** Ctrl+Shift+E: the program frame at the playhead as a full-size PNG (a YouTube thumbnail). */
export async function exportFrameCmd(): Promise<void> {
  flushLiveEdit();
  const doc = getDoc();
  if (!Object.keys(doc.timeline.clips).length) return toast('Add clips first, then pick a frame for your thumbnail.');
  const frame = getPlayhead();
  const out = await api.dialogs.saveFile({
    title: 'Save frame as PNG',
    defaultName: `${baseName()} thumbnail.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!out) return;
  toast('Saving the frame…');
  const { textImages, clipImages } = await exportImages(doc, { start: frame, end: frame + 1 });
  const r = await api.exporter.frame({ doc, frame, outputPath: out, textImages, clipImages });
  if (r.ok) toast(`Saved ${FORMATS[doc.timeline.settings.format].width}×${FORMATS[doc.timeline.settings.format].height} frame.`);
  else toast(r.error ?? 'Could not save the frame.', 'error');
}

/** Copies YouTube chapter timestamps (from chapter markers) to the clipboard. */
export async function copyChaptersCmd(): Promise<void> {
  const list = chapterList(getDoc().timeline);
  try {
    await navigator.clipboard.writeText(list.text);
  } catch {
    return toast('Could not use the clipboard.', 'error');
  }
  toast(list.problems.length ? `Copied ${list.count} chapters. Note: ${list.problems[0]}` : `Copied ${list.count} chapters. Paste them into your YouTube description.`, list.problems.length ? 'error' : 'info');
}

/** Saves the captions track as an .srt file (to upload to YouTube as subtitles). */
export async function exportSrtCmd(): Promise<void> {
  const tl = getDoc().timeline;
  const track = captionsTrack(tl);
  if (!track || !clipsOnTrack(tl, track.id).length) return toast('There are no captions yet. Use Auto captions first.');
  const out = await api.dialogs.saveFile({ title: 'Save captions', defaultName: `${baseName()}.srt`, filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }] });
  if (!out) return;
  await api.project.write(out, captionsToSrt(tl));
  toast('Captions saved as .srt.');
}
