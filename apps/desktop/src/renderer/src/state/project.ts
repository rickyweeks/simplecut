import { create } from 'zustand';
import {
  createHistory,
  createProjectDoc,
  currentEntry,
  currentState,
  jumpTo,
  pushHistory,
  redo,
  undo,
  type History,
  type ProjectDoc,
  type Timeline,
} from '@simplecut/core';

export interface ProjectMeta {
  /** Stable id used for crash-recovery files. */
  id: string;
  name: string;
  /** Where the .scut file lives, or null if never saved. */
  path: string | null;
}

interface ProjectState {
  history: History<ProjectDoc>;
  /** Shortcut for currentState(history). */
  doc: ProjectDoc;
  meta: ProjectMeta;
  /** History entry id at the last save (dirty = current entry differs). */
  savedEntryId: number;
  /** History entry id at the last autosave. */
  autosavedEntryId: number;

  commit(label: string, doc: ProjectDoc): void;
  commitTimeline(label: string, timeline: Timeline): void;
  undo(): void;
  redo(): void;
  jump(index: number): void;
  load(doc: ProjectDoc, meta: ProjectMeta, opts?: { dirty?: boolean }): void;
  markSaved(path: string, name: string): void;
  markAutosaved(): void;
}

export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function fresh(): Pick<ProjectState, 'history' | 'doc' | 'meta' | 'savedEntryId' | 'autosavedEntryId'> {
  const doc = createProjectDoc();
  const history = createHistory(doc, 'New project');
  return { history, doc, meta: { id: newProjectId(), name: 'Untitled', path: null }, savedEntryId: 1, autosavedEntryId: 1 };
}

export const useProject = create<ProjectState>((set, get) => ({
  ...fresh(),

  commit(label, doc) {
    const history = pushHistory(get().history, label, doc);
    if (history !== get().history) set({ history, doc });
  },
  commitTimeline(label, timeline) {
    const { doc } = get();
    if (timeline === doc.timeline) return;
    get().commit(label, { ...doc, timeline });
  },
  undo() {
    const history = undo(get().history);
    set({ history, doc: currentState(history) });
  },
  redo() {
    const history = redo(get().history);
    set({ history, doc: currentState(history) });
  },
  jump(index) {
    const history = jumpTo(get().history, index);
    set({ history, doc: currentState(history) });
  },
  load(doc, meta, opts = {}) {
    const history = createHistory(doc, meta.path ? 'Open project' : 'New project');
    // A recovered project starts dirty so the user is reminded to save it.
    const savedEntryId = opts.dirty ? 0 : 1;
    set({ history, doc, meta, savedEntryId, autosavedEntryId: 1 });
  },
  markSaved(path, name) {
    set({ meta: { ...get().meta, path, name }, savedEntryId: currentEntry(get().history).id });
  },
  markAutosaved() {
    set({ autosavedEntryId: currentEntry(get().history).id });
  },
}));

export const isDirty = (s: Pick<ProjectState, 'history' | 'savedEntryId'>) => currentEntry(s.history).id !== s.savedEntryId;

export const getDoc = () => useProject.getState().doc;
export const getTimeline = () => useProject.getState().doc.timeline;
