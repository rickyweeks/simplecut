import { defaultIds, type IdGen } from '../ids';
import { DEFAULT_TEXT_STYLE } from '../text/text';
import { setClips } from '../timeline/primitives';
import { clipsOnTrack, videoTracks } from '../timeline/query';
import { addTrack } from '../timeline/structure';
import { TEXT_MEDIA_ID, type Clip, type Frame, type Range, type TextContent, type TextStyle, type Timeline } from '../types';

/**
 * Auto captions. Speech is transcribed on this PC (whisper.cpp, one segment per word), the
 * words are grouped into short readable captions, and each caption becomes an editable title
 * clip on the captions track (the top video track). The same clips export as an .srt file.
 */

export interface CaptionWord {
  text: string;
  /** Seconds on the timeline. */
  start: number;
  end: number;
}

export interface Caption {
  text: string;
  start: number;
  end: number;
}

/**
 * whisper-cli arguments: English, full JSON with token-level DTW timestamps. (Segment and
 * token offsets are unreliable after silence; DTW times track the actual speech. DTW needs
 * flash attention off.)
 */
export function whisperArgs(modelPath: string, wavPath: string, outBase: string, threads: number, dtwModel = 'base.en'): string[] {
  return ['-m', modelPath, '-f', wavPath, '-l', 'en', '-ojf', '-dtw', dtwModel, '-nfa', '-of', outBase, '-t', String(Math.max(1, threads)), '-pp', '-np'];
}

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  /** Centiseconds, -1 when not computed. */
  t_dtw?: number;
}

/**
 * Reads whisper-cli's full JSON into words (timeline seconds). Words are rebuilt from tokens
 * (a token starting with a space starts a word; others, like "." or "'s", attach to it) and
 * timed by DTW, falling back to token offsets. A word ends where the next begins, unless
 * there's a pause.
 */
export function parseWhisperJson(json: string, offsetSec = 0): CaptionWord[] {
  const raw = JSON.parse(json) as { transcription?: { offsets?: { from?: number; to?: number }; text?: string; tokens?: WhisperToken[] }[] };
  const words: CaptionWord[] = [];
  let cur: { text: string; start: number } | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) words.push({ text: cur.text.trim(), start: cur.start, end: cur.start });
    cur = null;
  };
  for (const seg of raw.transcription ?? []) {
    const tokens = seg.tokens ?? [{ text: seg.text, offsets: seg.offsets }];
    for (const t of tokens) {
      const text = t.text ?? '';
      if (!text || text.startsWith('[_')) continue;
      const time = t.t_dtw != null && t.t_dtw >= 0 ? t.t_dtw / 100 : Number(t.offsets?.from ?? 0) / 1000;
      if (/^\s/.test(text) || !cur) {
        flush();
        cur = { text, start: offsetSec + time };
      } else {
        (cur as { text: string }).text += text;
      }
    }
    flush();
  }
  // Whisper marks non-speech like [MUSIC] or (laughs); captions skip those.
  const spoken = words.filter((w) => !/^[[(].*[\])][.,!?]*$/.test(w.text));
  spoken.forEach((w, i) => {
    const next = spoken[i + 1];
    w.start = Math.max(0, w.start - 0.05);
    const guess = w.start + Math.min(0.9, 0.12 + 0.06 * w.text.length);
    w.end = next && next.start - 0.05 < guess + 0.25 ? Math.max(w.start + 0.05, next.start - 0.05) : guess;
  });
  return spoken;
}

export interface GroupOptions {
  /** Longest caption, in characters. */
  maxChars: number;
  /** Longest caption on screen, in seconds. */
  maxSec: number;
  /** A pause this long starts a new caption. */
  pauseSec: number;
}

export const DEFAULT_GROUPING: GroupOptions = { maxChars: 32, maxSec: 3, pauseSec: 0.6 };

/** Groups words into captions: breaks at sentence ends, pauses, and length limits. */
export function groupWords(words: CaptionWord[], opts: GroupOptions = DEFAULT_GROUPING): Caption[] {
  const out: Caption[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join(' '), start: cur[0]!.start, end: cur[cur.length - 1]!.end });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1]!;
      const text = cur.map((x) => x.text).join(' ');
      const tooLong = text.length + 1 + w.text.length > opts.maxChars;
      const tooSlow = w.end - cur[0]!.start > opts.maxSec;
      const paused = w.start - last.end >= opts.pauseSec;
      const sentence = /[.!?]["')\]]?$/.test(last.text);
      if (tooLong || tooSlow || paused || sentence) flush();
    }
    cur.push(w);
  }
  flush();
  // Readable timing: at least 0.7 s on screen, and close small gaps so captions don't flicker.
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const next = out[i + 1];
    c.end = Math.max(c.end, c.start + 0.7);
    if (next) {
      if (next.start - c.end < 0.35) c.end = next.start;
      c.end = Math.min(c.end, next.start);
    }
  }
  return out.filter((c) => c.end > c.start);
}

export interface CaptionStyle {
  id: string;
  name: string;
  style: Partial<TextStyle>;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'clean', name: 'Clean', style: { font: 'Segoe UI', size: 64, bold: true, color: '#ffffff', outlineWidth: 6, outlineColor: '#000000', shadow: false, box: false } },
  { id: 'boxed', name: 'Boxed', style: { font: 'Segoe UI', size: 58, bold: true, color: '#ffffff', outlineWidth: 0, shadow: false, box: true, boxColor: '#000000', boxOpacity: 0.72, boxPadding: 16, boxRadius: 10 } },
  { id: 'bold', name: 'Bold Yellow', style: { font: 'Arial Black', size: 70, bold: true, color: '#ffe14d', outlineWidth: 9, outlineColor: '#000000', shadow: true, shadowBlur: 10, shadowDistance: 4, box: false } },
  { id: 'gaming', name: 'Gaming', style: { font: 'Impact', size: 80, bold: false, color: '#ffffff', outlineWidth: 8, outlineColor: '#000000', shadow: true, shadowColor: '#7c3aed', shadowBlur: 0, shadowDistance: 6, box: false } },
  { id: 'minimal', name: 'Minimal', style: { font: 'Segoe UI', size: 52, bold: false, color: '#ffffff', outlineWidth: 0, shadow: true, shadowBlur: 12, shadowDistance: 2, box: false } },
];

export function captionText(content: string, styleId: string): TextContent {
  const s = CAPTION_STYLES.find((x) => x.id === styleId) ?? CAPTION_STYLES[0]!;
  return { ...DEFAULT_TEXT_STYLE, ...s.style, x: 0.5, y: 0.84, align: 'center', animIn: 'none', animOut: 'none', content, preset: `caption:${s.id}` };
}

export const captionsTrack = (tl: Timeline) => videoTracks(tl).find((t) => t.captions);

/**
 * Puts captions on the captions track (made on top of the video tracks if needed). Captions
 * already there inside `replace` are removed first, so re-running captions just refreshes them.
 */
export function addCaptions(tl: Timeline, captions: Caption[], styleId: string, replace: Range, ids: IdGen = defaultIds): { timeline: Timeline; count: number } {
  let out = tl;
  let track = captionsTrack(out);
  if (!track) {
    out = addTrack(out, 'video', ids);
    const added = videoTracks(out).at(-1)!;
    out = { ...out, tracks: out.tracks.map((t) => (t.id === added.id ? { ...t, captions: true } : t)) };
    track = { ...added, captions: true };
  }
  const fps = out.settings.fps;
  const stale = clipsOnTrack(out, track.id).filter((c) => c.start < replace.end && c.start + c.duration > replace.start);
  const clips: Clip[] = [];
  let lastEnd: Frame = 0;
  for (const c of captions) {
    const start = Math.max(lastEnd, Math.round(c.start * fps));
    const end = Math.round(c.end * fps);
    if (end - start < 1) continue;
    clips.push({ id: ids(), trackId: track.id, mediaId: TEXT_MEDIA_ID, kind: 'video', start, duration: end - start, sourceIn: 0, text: captionText(c.text, styleId) });
    lastEnd = end;
  }
  // Anything else still on the track that would overlap a new caption goes too.
  const overlapping = clipsOnTrack(out, track.id).filter((o) => clips.some((n) => o.start < n.start + n.duration && n.start < o.start + o.duration));
  out = setClips(out, clips, [...stale, ...overlapping].map((c) => c.id));
  return { timeline: out, count: clips.length };
}

/** Restyles every caption (keeps each one's words and position). */
export function applyCaptionStyle(tl: Timeline, styleId: string): Timeline {
  const track = captionsTrack(tl);
  if (!track) return tl;
  const updates = clipsOnTrack(tl, track.id)
    .filter((c) => c.text)
    .map((c) => ({ ...c, text: { ...captionText(c.text!.content, styleId), x: c.text!.x, y: c.text!.y } }));
  return updates.length ? setClips(tl, updates) : tl;
}

export const captionStyleOf = (tl: Timeline): string | null => {
  const track = captionsTrack(tl);
  const first = track ? clipsOnTrack(tl, track.id).find((c) => c.text) : undefined;
  const p = first?.text?.preset;
  return p?.startsWith('caption:') ? p.slice(8) : null;
};

const srtTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

/** The captions track as SubRip (.srt), relative to `from` (e.g. the export In point). */
export function captionsToSrt(tl: Timeline, range?: Range): string {
  const track = captionsTrack(tl);
  if (!track) return '';
  const fps = tl.settings.fps;
  const from = range?.start ?? 0;
  const to = range?.end ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  let n = 0;
  for (const c of clipsOnTrack(tl, track.id)) {
    if (!c.text?.content.trim() || c.start + c.duration <= from || c.start >= to) continue;
    const s = Math.max(c.start, from) - from;
    const e = Math.min(c.start + c.duration, to) - from;
    lines.push(String(++n), `${srtTime(s / fps)} --> ${srtTime(e / fps)}`, c.text.content.trim(), '');
  }
  return lines.join('\r\n');
}

