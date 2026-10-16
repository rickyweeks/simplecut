import type { Frame, MediaInfo } from './types';

export function secondsToFrames(sec: number, fps: number): Frame {
  return Math.round(sec * fps);
}

export function framesToSeconds(frames: Frame, fps: number): number {
  return frames / fps;
}

/** Usable length of a media item in timeline frames. Still images are unlimited. */
export function mediaFrameCount(media: Pick<MediaInfo, 'kind' | 'durationSec'>, fps: number): Frame {
  if (media.kind === 'image') return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(media.durationSec * fps + 1e-6));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** HH:MM:SS:FF, like Premiere. */
export function formatTimecode(frame: Frame, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const totalSec = Math.floor(f / fps);
  const ff = f - totalSec * fps;
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

/**
 * Parses HH:MM:SS:FF, MM:SS:FF, SS:FF or a plain frame count.
 * Returns null for anything else.
 */
export function parseTimecode(text: string, fps: number): Frame | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(/[:;.]/);
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  while (nums.length < 4) nums.unshift(0);
  const [hh, mm, ss, ff] = nums as [number, number, number, number];
  if (ff >= fps || ss >= 60 || mm >= 60) return null;
  return ((hh * 60 + mm) * 60 + ss) * fps + ff;
}

/** Short human duration for the media bin: 0:07, 12:34, 1:02:03. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}
