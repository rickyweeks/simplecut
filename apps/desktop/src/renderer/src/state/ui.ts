import { create } from 'zustand';
import type { Clip, Frame, Id, Range, SilenceSettings, Timeline } from '@simplecut/core';

export type Tool = 'select' | 'razor' | 'text';
export type PanelId = 'bin' | 'source' | 'program' | 'timeline';
export type DialogId = 'export' | 'settings' | 'relink' | 'recovery' | 'pasteAttributes' | 'captions' | null;

/** Pauses found by Remove Silences, shown on the timeline for review before cutting. */
export interface SilenceReview {
  clipIds: Id[];
  trackIds: Id[];
  ranges: Range[];
  /** Per range: true = will be removed (click a range to keep it). */
  remove: boolean[];
  settings: SilenceSettings;
}

export interface Selection {
  clipIds: Id[];
  /** A transition, identified by the clip it belongs to and which edge. */
  transition: { clipId: Id; edge: 'in' | 'out' } | null;
  gap: (Range & { trackId: Id }) | null;
  markerId: Id | null;
  mediaIds: Id[];
}

export interface Prefs {
  /** Delete/Backspace closes gaps (Premiere's Ripple Delete) instead of leaving them. */
  rippleDelete: boolean;
  /** Export encoder preference. */
  encoder: 'auto' | 'software';
  playbackScale: 1 | 0.5 | 0.25;
  /** Seen the beginner tips. */
  tipsSeen: boolean;
  /** Finished (or skipped) the first-launch tutorial. */
  tutorialDone: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface UiState {
  tool: Tool;
  snapping: boolean;
  /** Timeline zoom: pixels per frame. */
  pxPerFrame: number;
  focus: PanelId;
  selection: Selection;
  /** Live result of an in-progress drag (move, trim, drop), drawn instead of the committed timeline. */
  preview: Timeline | null;
  /** Frame of the snap guide while dragging. */
  snapAt: Frame | null;
  inspectorOpen: boolean;
  inspectorTab: 'properties' | 'history';
  dialog: DialogId;
  shortcutsVisible: boolean;
  toasts: Toast[];
  clipboard: Clip[];
  prefs: Prefs;
  silences: SilenceReview | null;
  /** Step of the first-launch tutorial, or null when it is not showing. */
  tutorialStep: number | null;

  set(patch: Partial<UiState>): void;
  select(patch: Partial<Selection>): void;
  clearSelection(): void;
  setPrefs(patch: Partial<Prefs>): void;
  toast(text: string, kind?: Toast['kind']): void;
}

const PREFS_KEY = 'simplecut.prefs';
const defaultPrefs: Prefs = { rippleDelete: true, encoder: 'auto', playbackScale: 1, tipsSeen: false, tutorialDone: false };

function loadPrefs(): Prefs {
  try {
    return { ...defaultPrefs, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return defaultPrefs;
  }
}

const emptySelection: Selection = { clipIds: [], transition: null, gap: null, markerId: null, mediaIds: [] };
let toastSeq = 0;

export const useUi = create<UiState>((set, get) => ({
  tool: 'select',
  snapping: true,
  pxPerFrame: 2,
  focus: 'timeline',
  selection: emptySelection,
  preview: null,
  snapAt: null,
  inspectorOpen: true,
  inspectorTab: 'properties',
  dialog: null,
  shortcutsVisible: false,
  toasts: [],
  clipboard: [],
  prefs: loadPrefs(),
  silences: null,
  tutorialStep: null,

  set: (patch) => set(patch),
  select: (patch) => set({ selection: { ...emptySelection, ...patch } }),
  clearSelection: () => set({ selection: emptySelection }),
  setPrefs(patch) {
    const prefs = { ...get().prefs, ...patch };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // storage unavailable: keep in memory only
    }
    set({ prefs });
  },
  toast(text, kind = 'info') {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, kind }].slice(-4) });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 2600);
  },
}));

/** Timeline zoom limits (pixels per frame). */
export const MIN_PX_PER_FRAME = 0.02;
export const MAX_PX_PER_FRAME = 24;
