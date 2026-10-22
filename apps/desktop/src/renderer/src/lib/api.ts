import type { ScutApi } from '../../../shared/api';

declare global {
  interface Window {
    scut: ScutApi;
  }
}

/** The Electron bridge exposed by the preload script. */
export const api: ScutApi = window.scut;

/** Payload for drag-and-drop from the bin / source monitor to the timeline. */
export interface DragSource {
  mediaId: string;
  inSec: number;
  outSec: number | null;
  video: boolean;
  audio: boolean;
}

/**
 * During HTML5 drag-and-drop the payload can only be read on drop, but the timeline wants
 * to preview the edit while dragging, so the current payload is also kept here.
 */
let currentDrag: DragSource | null = null;
export const DRAG_MIME = 'application/x-simplecut-media';
/** Title preset id, dragged from the Titles list. */
export const TITLE_MIME = 'application/x-simplecut-title';
/** Transition type, dragged from the Transitions list. */
export const TRANSITION_MIME = 'application/x-simplecut-transition';

export function beginDrag(e: React.DragEvent, src: DragSource): void {
  currentDrag = src;
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(src));
  e.dataTransfer.effectAllowed = 'copy';
}

export function activeDrag(): DragSource | null {
  return currentDrag;
}

export function endDrag(): void {
  currentDrag = null;
}
