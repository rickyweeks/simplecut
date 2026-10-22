import { timelineDuration } from '../timeline/query';
import type { Timeline } from '../types';

/**
 * YouTube chapters from markers flagged as chapters: "00:00 Intro" lines for the video
 * description. YouTube only shows chapters when the list starts at 0:00, has at least three
 * entries and every chapter is at least 10 seconds long; problems are reported, not hidden.
 */

export interface ChapterList {
  text: string;
  count: number;
  /** Plain-language reasons YouTube would ignore the chapters (empty = good to go). */
  problems: string[];
}

function stamp(sec: number, long: boolean): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return long ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

export function chapterList(tl: Timeline, offsetFrames = 0): ChapterList {
  const fps = tl.settings.fps;
  const end = timelineDuration(tl);
  const marks = tl.markers
    .filter((m) => m.chapter && m.frame >= offsetFrames)
    .map((m) => ({ frame: m.frame - offsetFrames, label: m.label.trim() }))
    .sort((a, b) => a.frame - b.frame);
  const problems: string[] = [];
  // YouTube requires the first chapter at 0:00; add an "Intro" if the first marker is later.
  if (!marks.length || marks[0]!.frame >= fps) marks.unshift({ frame: 0, label: 'Intro' });
  else marks[0] = { ...marks[0]!, frame: 0 };
  const long = (end - offsetFrames) / fps >= 3600;
  const lines = marks.map((m, i) => `${stamp(m.frame / fps, long)} ${m.label || `Chapter ${i + 1}`}`);
  if (marks.length < 3) problems.push(`YouTube needs at least 3 chapters (you have ${marks.length}). Add chapter markers with M, then tick "YouTube chapter".`);
  const short = marks.filter((m, i) => ((marks[i + 1]?.frame ?? end - offsetFrames) - m.frame) / fps < 10);
  if (short.length) problems.push(`Each chapter must be at least 10 seconds long (${short.map((m) => m.label || 'untitled').join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter).`);
  if (marks.some((m) => !m.label)) problems.push('Some chapter markers have no name; they were called "Chapter N".');
  return { text: lines.join('\n'), count: marks.length, problems };
}
