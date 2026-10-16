import { create } from 'zustand';
import type { Frame } from '@simplecut/core';

/**
 * The program (timeline) playhead lives in its own tiny store: it changes every frame
 * during playback, and only the few components that show it should re-render.
 */
interface PlayheadState {
  frame: Frame;
  playing: boolean;
  /** Playback rate: 1, 2, 4 forward; -1, -2, -4 reverse. */
  rate: number;
  set(frame: Frame): void;
}

export const usePlayhead = create<PlayheadState>((set) => ({
  frame: 0,
  playing: false,
  rate: 0,
  set: (frame) => set({ frame: Math.max(0, Math.round(frame)) }),
}));

export const getPlayhead = () => usePlayhead.getState().frame;
export const setPlayhead = (frame: Frame) => usePlayhead.getState().set(frame);
