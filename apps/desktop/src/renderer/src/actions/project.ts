import {
  ProjectFileError,
  addMedia,
  basename,
  createMediaItem,
  createProjectDoc,
  isImportable,
  parseProject,
  serializeProject,
  stem,
  updateMedia,
  type MediaItem,
  type ProjectDoc,
} from '@simplecut/core';
import { api } from '../lib/api';
import { programEngine } from '../playback/engine';
import { prepareAssets, useAssets } from '../state/assets';
import { setPlayhead } from '../state/playhead';
import { getDoc, isDirty, newProjectId, useProject, type ProjectMeta } from '../state/project';
import { useSource } from '../state/source';
import { useUi } from '../state/ui';

const APP_VERSION = '0.1.0';
const toast = (text: string, kind?: 'info' | 'error') => useUi.getState().toast(text, kind);
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Probes files and adds them to the bin. Returns the new (or already present) items in order. */
export async function importPaths(paths: string[]): Promise<MediaItem[]> {
  const supported = paths.filter(isImportable);
  const skipped = paths.length - supported.length;
  if (skipped) toast(`Skipped ${skipped} file${skipped === 1 ? '' : 's'} SimpleCut can't import (use MP4, MOV, MKV, WebM, AVI, MP3, WAV, AAC, M4A, FLAC, OGG, PNG or JPG).`, 'error');
  if (!supported.length) return [];

  const existing = new Map(Object.values(getDoc().media).map((m) => [m.path.toLowerCase(), m]));
  const results: (MediaItem | null)[] = new Array(supported.length).fill(null);
  const fresh: MediaItem[] = [];
  let next = 0;
  const worker = async () => {
    while (next < supported.length) {
      const i = next++;
      const path = supported[i]!;
      const known = existing.get(path.toLowerCase());
      if (known) {
        results[i] = known;
        continue;
      }
      try {
        const info = await api.media.probe(path);
        const item = createMediaItem(info, path);
        results[i] = item;
        fresh.push(item);
      } catch (e) {
        toast(`Couldn't read "${basename(path)}": ${errText(e)}`, 'error');
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  if (fresh.length) {
    const ordered = results.filter((m): m is MediaItem => !!m && fresh.includes(m));
    useProject.getState().commit(`Import ${ordered.length} file${ordered.length === 1 ? '' : 's'}`, addMedia(getDoc(), ordered));
    for (const m of ordered) prepareAssets(m);
    const firstVideo = ordered.find((m) => m.kind !== 'audio') ?? ordered[0];
    if (!useSource.getState().mediaId && firstVideo) useSource.getState().load(firstVideo.id);
  }
  return results.filter((m): m is MediaItem => !!m);
}

export async function importDialog(): Promise<void> {
  const paths = await api.dialogs.openMedia();
  if (paths.length) await importPaths(paths);
}

// ---------------------------------------------------------------------------
// New / open / save
// ---------------------------------------------------------------------------

/** Asks to save unsaved changes. Resolves false if the user cancels. */
export async function confirmDiscard(action: string): Promise<boolean> {
  const p = useProject.getState();
  if (!isDirty(p)) return true;
  const r = await api.dialogs.confirm({
    message: `Save changes to "${p.meta.name}" before ${action}?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: ['Save', "Don't save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r === 2) return false;
  if (r === 0) return saveProject();
  return true;
}

function resetSession(): void {
  programEngine()?.pause();
  setPlayhead(0);
  useSource.getState().load(null);
  useUi.getState().select({});
  useUi.getState().set({ preview: null, dialog: null });
}

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard('starting a new project'))) return;
  await api.recovery.clear(useProject.getState().meta.id).catch(() => {});
  resetSession();
  useProject.getState().load(createProjectDoc(), { id: newProjectId(), name: 'Untitled', path: null });
}

export async function openProjectDialog(): Promise<void> {
  if (!(await confirmDiscard('opening another project'))) return;
  const path = await api.dialogs.openProject();
  if (path) await openProjectPath(path, { skipConfirm: true });
}

export async function openProjectPath(path: string, opts: { skipConfirm?: boolean } = {}): Promise<void> {
  if (!opts.skipConfirm && !(await confirmDiscard('opening another project'))) return;
  let parsed;
  try {
    parsed = parseProject(await api.project.read(path), path, 'win32');
  } catch (e) {
    toast(e instanceof ProjectFileError ? e.message : `Couldn't open the project: ${errText(e)}`, 'error');
    return;
  }
  await api.recovery.clear(useProject.getState().meta.id).catch(() => {});
  resetSession();
  const doc = await resolveMedia(parsed.doc, parsed.mediaCandidates);
  useProject.getState().load(doc, { id: parsed.meta.id, name: parsed.meta.name || stem(path), path });
  afterLoad();
}

/**
 * Picks the first existing candidate path for each media item (next to the project
 * first, then the original location) and marks the rest offline.
 */
async function resolveMedia(doc: ProjectDoc, candidates: Record<string, string[]>): Promise<ProjectDoc> {
  let out = doc;
  const { setOffline } = useAssets.getState();
  for (const m of Object.values(doc.media)) {
    const paths = candidates[m.id] ?? [m.path];
    const exists = paths.length ? await api.project.exists(paths) : [];
    const found = paths.find((_, i) => exists[i]);
    if (found) {
      if (found !== m.path) out = updateMedia(out, m.id, { path: found });
      setOffline(m.id, false);
    } else {
      setOffline(m.id, true);
    }
  }
  return out;
}

function afterLoad(): void {
  const doc = getDoc();
  const { offline } = useAssets.getState();
  for (const m of Object.values(doc.media)) if (!offline[m.id]) prepareAssets(m);
  if (Object.values(doc.media).some((m) => offline[m.id])) useUi.getState().set({ dialog: 'relink' });
  const first = Object.values(doc.media).find((m) => !offline[m.id]);
  if (first) useSource.getState().load(first.id);
}

export async function saveProject(): Promise<boolean> {
  const { meta } = useProject.getState();
  if (!meta.path) return saveProjectAs();
  return writeProject(meta.path, meta.name);
}

export async function saveProjectAs(): Promise<boolean> {
  const { meta } = useProject.getState();
  const path = await api.dialogs.saveProject(meta.name);
  if (!path) return false;
  return writeProject(path, stem(path));
}

async function writeProject(path: string, name: string): Promise<boolean> {
  const p = useProject.getState();
  const meta: ProjectMeta = { ...p.meta, path, name };
  try {
    await api.project.write(path, serializeProject(p.doc, { id: meta.id, name }, path, { appVersion: APP_VERSION }));
  } catch (e) {
    toast(`Couldn't save: ${errText(e)}`, 'error');
    return false;
  }
  p.markSaved(path, name);
  await api.recovery.clear(meta.id).catch(() => {});
  toast(`Saved "${name}"`);
  return true;
}

// ---------------------------------------------------------------------------
// Relink
// ---------------------------------------------------------------------------

/** Points a media item at a new file (re-probing it), then looks for other missing files next to it. */
export async function relinkMedia(mediaId: string, newPath: string, searchSiblings = true): Promise<boolean> {
  try {
    const info = await api.media.probe(newPath);
    const doc = updateMedia(getDoc(), mediaId, { ...info, path: newPath });
    useProject.getState().commit('Relink media', doc);
    useAssets.getState().setOffline(mediaId, false);
    prepareAssets(doc.media[mediaId]!);
  } catch (e) {
    toast(`Couldn't use that file: ${errText(e)}`, 'error');
    return false;
  }
  if (!searchSiblings) return true;
  // Moved folders usually moved together: try the same folder for everything else.
  const folder = newPath.replace(/[\\/][^\\/]*$/, '');
  const { offline } = useAssets.getState();
  const missing = Object.values(getDoc().media).filter((m) => offline[m.id]);
  if (missing.length) {
    const found = await api.project.findInFolder(folder, missing.map((m) => basename(m.path)));
    let relinked = 0;
    for (const m of missing) {
      const p = found[basename(m.path)];
      if (p && (await relinkMedia(m.id, p, false))) relinked++;
    }
    if (relinked) toast(`Also found ${relinked} other missing file${relinked === 1 ? '' : 's'} in the same folder.`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Autosave and crash recovery
// ---------------------------------------------------------------------------

/** Every 60 s, writes a recovery copy if there are changes since the last save/autosave. */
export function startAutosave(): () => void {
  const timer = setInterval(() => {
    const p = useProject.getState();
    const current = p.history.entries[p.history.index]!.id;
    if (!isDirty(p) || current === p.autosavedEntryId) return;
    const text = serializeProject(p.doc, { id: p.meta.id, name: p.meta.name }, null, { appVersion: APP_VERSION });
    api.recovery
      .write(p.meta.id, text, { name: p.meta.name, projectPath: p.meta.path })
      .then(() => useProject.getState().markAutosaved())
      .catch(() => {});
  }, 60_000);
  return () => clearInterval(timer);
}

export async function recoverProject(id: string, name: string, projectPath: string | null): Promise<void> {
  try {
    const parsed = parseProject(await api.recovery.read(id), null, 'win32');
    resetSession();
    const doc = await resolveMedia(parsed.doc, parsed.mediaCandidates);
    useProject.getState().load(doc, { id, name, path: projectPath }, { dirty: true });
    afterLoad();
    toast(`Recovered "${name}". Save to keep it.`);
  } catch (e) {
    toast(`Couldn't recover the project: ${errText(e)}`, 'error');
  }
}

/** The window wants to close: offer to save, then let it close. */
export async function handleCloseRequest(): Promise<void> {
  if (!(await confirmDiscard('closing'))) return;
  await api.recovery.clear(useProject.getState().meta.id).catch(() => {});
  api.app.confirmClose();
}

export function startTitleSync(): () => void {
  const update = () => {
    const p = useProject.getState();
    api.app.setTitle(`${isDirty(p) ? '• ' : ''}${p.meta.name} — SimpleCut`);
  };
  update();
  return useProject.subscribe(update);
}
