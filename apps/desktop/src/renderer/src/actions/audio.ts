import {
  DEFAULT_TRANSITION_SECONDS,
  TRANSITION_LABELS,
  YOUTUBE_LUFS,
  cutNearPlayhead,
  normalizationGain,
  setTransition,
  timelineDuration,
  updateClips,
  type ClipProps,
  type Id,
  type Timeline,
  type TransitionType,
} from '@simplecut/core';
import { api } from '../lib/api';
import { duckRegionsFor } from '../state/ducking';
import { getPlayhead } from '../state/playhead';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';

const toast = (text: string, kind?: 'info' | 'error') => useUi.getState().toast(text, kind);
const commit = (label: string, tl: Timeline) => useProject.getState().commitTimeline(label, tl);

/** Volume, fades, noise reduction or title changes from the Inspector or clip handles. */
export function updateClipProps(clipIds: Id[], patch: ClipProps, label: string): void {
  commit(label, updateClips(getTimeline(), clipIds, patch));
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Ctrl+D (video) / Shift+Ctrl+D (audio): the default transition. With clips selected it
 * goes on both ends of each; otherwise on the cut nearest the playhead on the targeted track.
 */
export function applyDefaultTransition(kind: 'video' | 'audio', chosen?: TransitionType): void {
  let tl = getTimeline();
  const type: TransitionType = chosen ?? (kind === 'video' ? 'dissolve' : 'crossfade');
  const transition = { type, duration: Math.round(DEFAULT_TRANSITION_SECONDS * tl.settings.fps) };
  const selected = useUi.getState().selection.clipIds.map((id) => tl.clips[id]).filter((c) => c && c.kind === kind);
  if (selected.length) {
    for (const c of selected) {
      tl = setTransition(tl, c!.id, 'in', transition);
      tl = setTransition(tl, c!.id, 'out', transition);
    }
    commit(`Add ${TRANSITION_LABELS[type]}`, tl);
    toast(`${TRANSITION_LABELS[type]} added to both ends of the selected clip${selected.length === 1 ? '' : 's'}.`);
    return;
  }
  const trackId = kind === 'video' ? tl.targetVideoTrackId : tl.targetAudioTrackId;
  const cut = trackId ? cutNearPlayhead(tl, trackId, getPlayhead(), tl.settings.fps) : null;
  if (!cut) {
    toast(`Move the playhead next to a cut on the targeted ${kind} track (or select clips), then press ${kind === 'video' ? 'Ctrl+D' : 'Shift+Ctrl+D'}.`);
    return;
  }
  commit(`Add ${TRANSITION_LABELS[type]}`, setTransition(tl, cut.clip.id, cut.edge, transition));
  const after = getTimeline();
  const owner = cut.edge === 'out' && !after.clips[cut.clip.id]?.transitionOut ? null : cut;
  useUi.getState().select({ transition: owner ? { clipId: owner.clip.id, edge: owner.edge } : null });
}

/** Drag-and-drop from the Transitions list onto a clip edge. */
export function dropTransition(clipId: Id, edge: 'in' | 'out', type: TransitionType): void {
  const tl = getTimeline();
  const clip = tl.clips[clipId];
  if (!clip) return;
  if ((type === 'crossfade') !== (clip.kind === 'audio')) {
    toast(type === 'crossfade' ? 'Audio crossfades go between audio clips.' : 'Video transitions go between video clips.');
    return;
  }
  const next = setTransition(tl, clipId, edge, { type, duration: Math.round(DEFAULT_TRANSITION_SECONDS * tl.settings.fps) });
  commit(`Add ${TRANSITION_LABELS[type]}`, next);
}

export function updateTransition(clipId: Id, edge: 'in' | 'out', patch: { type?: TransitionType; duration?: number }): void {
  const tl = getTimeline();
  const current = edge === 'in' ? tl.clips[clipId]?.transitionIn : tl.clips[clipId]?.transitionOut;
  if (!current) return;
  commit('Change transition', setTransition(tl, clipId, edge, { ...current, ...patch }));
}

export function removeTransition(clipId: Id, edge: 'in' | 'out'): void {
  commit('Remove transition', setTransition(getTimeline(), clipId, edge, null));
  useUi.getState().select({});
}

// ---------------------------------------------------------------------------
// Loudness
// ---------------------------------------------------------------------------

let measuring = false;

/** One click: measure the mix and set the master gain so it plays at −14 LUFS on YouTube. */
export async function normalizeLoudness(): Promise<void> {
  if (measuring) return;
  const doc = getDoc();
  const end = timelineDuration(doc.timeline);
  if (!end) return toast('Add some clips first.');
  measuring = true;
  toast('Measuring loudness…');
  try {
    const m = await api.exporter.measureLoudness({ doc, range: { start: 0, end }, duckRegions: duckRegionsFor(doc.timeline) });
    if (!m || !Number.isFinite(m.integratedLufs) || m.integratedLufs < -70) {
      toast('The timeline is silent, so there is nothing to normalize.');
      return;
    }
    const { gainDb, limitedByPeak } = normalizationGain(m);
    const tl = getTimeline();
    commit('Normalize loudness', { ...tl, masterGainDb: gainDb, loudness: m });
    toast(
      limitedByPeak
        ? `Raised by ${gainDb} dB. Peaks stop it reaching ${YOUTUBE_LUFS} LUFS (now ${(m.integratedLufs + gainDb).toFixed(1)} LUFS).`
        : `Mix set to ${YOUTUBE_LUFS} LUFS (${gainDb >= 0 ? '+' : ''}${gainDb} dB).`,
    );
  } catch (e) {
    toast(`Couldn't measure loudness: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    measuring = false;
  }
}

export function resetLoudness(): void {
  const { masterGainDb: _g, loudness: _l, ...rest } = getTimeline();
  commit('Reset loudness', rest);
}

export function setDuckDepth(db: number): void {
  commit(db === 0 ? 'Ducking off' : 'Ducking amount', { ...getTimeline(), duckDb: db });
}
