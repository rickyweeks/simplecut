import {
  DEFAULT_SILENCE,
  clipsOnTrack,
  expandSelection,
  removeSilences,
  silenceRanges,
  silenceTracks,
  sourceSpan,
  totalFrames,
  type Clip,
  type SilenceSettings,
} from '@simplecut/core';
import { api } from '../lib/api';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { pruneSelection } from './edit';

/**
 * Remove Silences (auto jump cut): finds the pauses in the selected talking clips, shows
 * them on the timeline for review (click one to keep it), then cuts them all in one undo step.
 */

const toast = (text: string, kind?: 'info' | 'error') => useUi.getState().toast(text, kind);
let busy = false;

/** The sound clips to analyse: the selection's audio (and linked audio), else the targeted audio track. */
function targetClips(): Clip[] {
  const tl = getTimeline();
  const sel = useUi.getState().selection.clipIds;
  const ids = sel.length ? expandSelection(tl, sel) : [];
  let clips = ids.map((id) => tl.clips[id]).filter((c): c is Clip => !!c && c.kind === 'audio');
  if (!sel.length && tl.targetAudioTrackId) clips = clipsOnTrack(tl, tl.targetAudioTrackId);
  const music = tl.tracks.find((t) => t.music)?.id;
  return clips.filter((c) => c.trackId !== music && getDoc().media[c.mediaId]);
}

export async function findSilences(settings: SilenceSettings = useUi.getState().silences?.settings ?? DEFAULT_SILENCE): Promise<void> {
  if (busy) return;
  const clips = targetClips();
  if (!clips.length) return toast('Select the talking clips (with sound) to remove pauses from.');
  busy = true;
  toast('Listening for pauses…');
  try {
    const tl = getTimeline();
    const fps = tl.settings.fps;
    const ranges = [];
    for (const c of clips) {
      const m = getDoc().media[c.mediaId]!;
      const startSec = c.sourceIn / fps;
      const durationSec = sourceSpan(c, c.duration) / fps;
      const pauses = await api.media.silences({ path: m.path, startSec, durationSec, settings });
      ranges.push(...silenceRanges(c, pauses, fps, settings));
    }
    ranges.sort((a, b) => a.start - b.start);
    if (!ranges.length) {
      useUi.getState().set({ silences: null });
      return toast('No pauses found with these settings. Try a lower minimum length or a higher threshold.');
    }
    useUi.getState().set({
      silences: { clipIds: clips.map((c) => c.id), trackIds: silenceTracks(tl, clips.map((c) => c.id)), ranges, remove: ranges.map(() => true), settings },
    });
  } catch (e) {
    toast(`Couldn't analyse the audio: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    busy = false;
  }
}

/** Click a pause on the timeline to keep it (or include it again). */
export function toggleSilence(index: number): void {
  const s = useUi.getState().silences;
  if (!s) return;
  useUi.getState().set({ silences: { ...s, remove: s.remove.map((r, i) => (i === index ? !r : r)) } });
}

export function cancelSilences(): void {
  useUi.getState().set({ silences: null });
}

export function applySilences(): void {
  const s = useUi.getState().silences;
  if (!s) return;
  const ranges = s.ranges.filter((_, i) => s.remove[i]);
  useUi.getState().set({ silences: null });
  if (!ranges.length) return;
  const tl = getTimeline();
  useProject.getState().commitTimeline(`Remove ${ranges.length} pause${ranges.length === 1 ? '' : 's'}`, removeSilences(tl, s.trackIds, ranges));
  pruneSelection();
  toast(`Removed ${ranges.length} pause${ranges.length === 1 ? '' : 's'} (${(totalFrames(ranges) / tl.settings.fps).toFixed(1)} s).`);
}
