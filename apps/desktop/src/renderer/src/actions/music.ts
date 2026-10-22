import {
  addBeatMarkers,
  addMusic,
  cutClipsOnBeats,
  defaultIds,
  expandSelection,
  musicBeatFrames,
  nextEditPoint,
  updateMedia,
  updateTrack,
  type Frame,
  type MediaItem,
} from '@simplecut/core';
import { api } from '../lib/api';
import { getPlayhead } from '../state/playhead';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { pruneSelection, seekProgram } from './edit';
import { importPaths } from './project';

const toast = (text: string, kind?: 'info' | 'error') => useUi.getState().toast(text, kind);

/**
 * "Add music": the song goes on the music track. Whatever goes there is treated as music:
 * its beats are detected and shown on the clip, clips snap to them, and the track ducks
 * under dialogue. No guessing whether something is music.
 */
export async function addMusicCmd(): Promise<void> {
  const ui = useUi.getState();
  const doc = getDoc();
  let media: MediaItem | undefined = ui.selection.mediaIds.map((id) => doc.media[id]).find((m) => m?.hasAudio);
  if (!media) {
    const paths = await api.dialogs.openMedia();
    if (!paths.length) return;
    const items = await importPaths(paths);
    media = items.find((m) => m.hasAudio);
    if (!media) return toast('That file has no sound to use as music.', 'error');
  }
  const r = addMusic(getTimeline(), media, defaultIds);
  useProject.getState().commitTimeline('Add music', r.timeline);
  if (r.clipId) useUi.getState().select({ clipIds: [r.clipId] });
  void ensureBeats(media);
}

const analysing = new Set<string>();

/** Detects the beats of a song once (cached on disk) and stores them on the media item. */
export async function ensureBeats(media: MediaItem): Promise<void> {
  if (media.beats || analysing.has(media.id)) return;
  analysing.add(media.id);
  toast(`Finding the beat in “${media.name}”…`);
  try {
    const beats = await api.media.analyzeBeats(media.path);
    if (!getDoc().media[media.id]) return;
    // Not an undo step: undoing would only make the watcher detect them again (and lose redo).
    useProject.getState().annotate((d) => (d.media[media.id] && !d.media[media.id]!.beats ? updateMedia(d, media.id, { beats }) : d));
    if (beats.confidence < 0.15 || beats.beats.length < 8) toast('No steady beat found in this song, so there are no beat markers.');
    else toast(`${Math.round(beats.bpm)} BPM · ${beats.beats.length} beats. Clips now snap to the beat.`);
  } catch (e) {
    toast(`Couldn't analyse the music: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    analysing.delete(media.id);
  }
}

/** Keeps beats available for everything on the music track (e.g. clips dragged onto it). */
export function startMusicWatcher(): () => void {
  const check = () => {
    const { doc } = useProject.getState();
    const music = doc.timeline.tracks.find((t) => t.music);
    if (!music) return;
    for (const c of Object.values(doc.timeline.clips)) {
      if (c.trackId !== music.id) continue;
      const m = doc.media[c.mediaId];
      if (m && !m.beats) void ensureBeats(m);
    }
  };
  check();
  return useProject.subscribe(check);
}

export function setMusicTrack(trackId: string, on: boolean): void {
  useProject.getState().commitTimeline(on ? 'Set music track' : 'Unset music track', updateTrack(getTimeline(), trackId, { music: on }));
  if (on) toast('Music track: beats show on its clips, clips snap to them, and it ducks under dialogue.');
}

export function beatFrames(which: 'beats' | 'downbeats' = 'beats'): Frame[] {
  return musicBeatFrames(getTimeline(), getDoc().media, which);
}

export function addBeatMarkersCmd(which: 'beats' | 'downbeats'): void {
  const frames = beatFrames(which);
  if (!frames.length) return toast('Add music first (the ♪ button) to get beat markers.');
  useProject.getState().commitTimeline(which === 'beats' ? 'Beat markers' : 'Bar markers', addBeatMarkers(getTimeline(), getDoc().media, which, defaultIds));
  toast(`Added ${frames.length} ${which === 'beats' ? 'beat' : 'bar'} markers.`);
}

/** Splits the selected clips on every beat (or bar), for cutting a montage to the music. */
export function cutSelectionOnBeats(which: 'beats' | 'downbeats'): void {
  const frames = beatFrames(which);
  if (!frames.length) return toast('Add music first (the ♪ button) to cut on the beat.');
  const tl = getTimeline();
  const music = tl.tracks.find((t) => t.music)?.id;
  const ids = expandSelection(tl, useUi.getState().selection.clipIds).filter((id) => tl.clips[id]?.trackId !== music);
  if (!ids.length) return toast('Select the clips to cut on the beat (not the music itself).');
  useProject.getState().commitTimeline(which === 'beats' ? 'Cut on beats' : 'Cut on bars', cutClipsOnBeats(tl, ids, frames, defaultIds));
  pruneSelection();
}

/** Shift+↑ / Shift+↓: previous / next beat. */
export function goToBeat(dir: -1 | 1): void {
  const frames = beatFrames('beats');
  const now = getPlayhead();
  const f = dir > 0 ? frames.find((b) => b > now) : [...frames].reverse().find((b) => b < now);
  if (f != null) seekProgram(f);
  else if (!frames.length) {
    const e = nextEditPoint(getTimeline(), now);
    if (e != null && dir > 0) seekProgram(e);
  }
}
