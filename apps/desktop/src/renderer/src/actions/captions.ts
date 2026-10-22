import { create } from 'zustand';
import { addCaptions, applyCaptionStyle, groupWords, markedRange, timelineDuration } from '@simplecut/core';
import { api } from '../lib/api';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { flushLiveEdit } from './edit';

/**
 * Auto captions: the speech model is downloaded once (the dialog asks first), then the
 * timeline's speech is transcribed on this PC and laid out as editable captions.
 */

export type CaptionStage = 'idle' | 'checking' | 'needsModel' | 'downloading' | 'ready' | 'audio' | 'transcribe' | 'done' | 'error';

interface CaptionJob {
  stage: CaptionStage;
  fraction: number | null;
  message: string | null;
  modelBytes: number;
  styleId: string;
}

export const useCaptionJob = create<CaptionJob>(() => ({ stage: 'idle', fraction: null, message: null, modelBytes: 0, styleId: 'clean' }));
const set = (p: Partial<CaptionJob>) => useCaptionJob.setState(p);
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

let unsubscribe: (() => void) | null = null;
function listen(): void {
  unsubscribe ??= api.captions.onProgress((p) => {
    const stage = useCaptionJob.getState().stage;
    if (stage === 'downloading' || stage === 'audio' || stage === 'transcribe') set({ stage: p.stage === 'download' ? 'downloading' : p.stage, fraction: p.fraction });
  });
}

/** Opens the captions dialog and checks whether the speech model is there. */
export async function openCaptions(): Promise<void> {
  listen();
  useUi.getState().set({ dialog: 'captions' });
  const busy = ['downloading', 'audio', 'transcribe'].includes(useCaptionJob.getState().stage);
  if (busy) return;
  set({ stage: 'checking', message: null, fraction: null });
  const s = await api.captions.modelStatus();
  set({ stage: s.ready ? 'ready' : 'needsModel', modelBytes: s.sizeBytes });
}

export async function downloadModel(): Promise<void> {
  set({ stage: 'downloading', fraction: 0, message: null });
  try {
    await api.captions.downloadModel();
    set({ stage: 'ready', fraction: null });
  } catch (e) {
    const msg = errText(e);
    set({ stage: msg === 'Cancelled' ? 'needsModel' : 'error', message: msg === 'Cancelled' ? null : msg });
  }
}

export function cancelCaptionJob(): void {
  void api.captions.cancel();
}

/** Transcribes the timeline (or the In/Out range) and puts the captions on the captions track. */
export async function createCaptions(): Promise<void> {
  flushLiveEdit();
  const doc = getDoc();
  const tl = doc.timeline;
  const range = markedRange(tl) ?? { start: 0, end: timelineDuration(tl) };
  if (range.end <= range.start) return set({ stage: 'error', message: 'The timeline is empty.' });
  set({ stage: 'audio', fraction: 0, message: null });
  try {
    const words = await api.captions.transcribe({ doc, range });
    const caps = groupWords(words);
    if (!caps.length) {
      set({ stage: 'error', message: 'No speech was found. Captions need spoken words on the timeline (the music track is skipped).' });
      return;
    }
    const { timeline, count } = addCaptions(getTimeline(), caps, useCaptionJob.getState().styleId, range);
    useProject.getState().commitTimeline('Auto captions', timeline);
    set({ stage: 'done', fraction: null, message: `${count} captions added on the captions track. Click one to edit its words.` });
  } catch (e) {
    const msg = errText(e);
    set({ stage: msg === 'Cancelled' ? 'ready' : 'error', message: msg === 'Cancelled' ? null : msg });
  }
}

/** Picks the style for new captions and restyles the existing ones. */
export function setCaptionStyle(styleId: string): void {
  set({ styleId });
  const tl = getTimeline();
  const next = applyCaptionStyle(tl, styleId);
  if (next !== tl) useProject.getState().commitTimeline('Caption style', next);
}
