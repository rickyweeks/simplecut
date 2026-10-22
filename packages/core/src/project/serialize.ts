import { DEFAULT_GRADE } from '../color/grade';
import { DEFAULT_TRANSFORM } from '../timeline/transform';
import type { ColorGrade, Transform } from '../types';
import {
  FORMATS,
  FRAME_RATES,
  MARKER_COLORS,
  type BeatAnalysis,
  type Clip,
  type FrameRate,
  type Id,
  type Marker,
  type MediaItem,
  type ProjectDoc,
  type TextContent,
  type Timeline,
  type Track,
  type Transition,
} from '../types';
import { DEFAULT_TEXT_STYLE } from '../text/text';
import { dirname, relativePath, resolvePath, toNativePath, toPortablePath } from './paths';

/**
 * .scut project file: a single human-readable JSON document.
 *
 * - `version` is bumped whenever the shape changes; older files are migrated on load.
 * - Media paths are stored relative to the project file (when on the same drive) plus an
 *   absolute fallback, both with forward slashes, so a project folder can be moved or
 *   opened on another platform.
 */
export const PROJECT_FORMAT = 'simplecut-project';
export const PROJECT_VERSION = 3;
export const PROJECT_EXTENSION = '.scut';

export interface ProjectMeta {
  /** Stable id, used for crash-recovery files. */
  id: string;
  name: string;
}

interface MediaEntry extends Omit<MediaItem, 'path'> {
  /** Relative to the project file, or null when impossible (different drive / unsaved project). */
  path: string | null;
  absolutePath: string;
}

interface ProjectFileV1 {
  format: typeof PROJECT_FORMAT;
  version: number;
  app: string;
  savedAt: string;
  project: ProjectMeta;
  media: MediaEntry[];
  timeline: Timeline;
}

export class ProjectFileError extends Error {}

export function serializeProject(
  doc: ProjectDoc,
  meta: ProjectMeta,
  projectFilePath: string | null,
  opts: { appVersion?: string; now?: Date } = {},
): string {
  const projectDir = projectFilePath ? dirname(toPortablePath(projectFilePath)) : null;
  const media: MediaEntry[] = Object.values(doc.media).map((m) => {
    const absolutePath = toPortablePath(m.path);
    const { path: _p, ...rest } = m;
    return { ...rest, path: projectDir ? relativePath(projectDir, absolutePath) : null, absolutePath };
  });
  const file: ProjectFileV1 = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: `SimpleCut ${opts.appVersion ?? ''}`.trim(),
    savedAt: (opts.now ?? new Date()).toISOString(),
    project: meta,
    media,
    timeline: doc.timeline,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export interface ParsedProject {
  doc: ProjectDoc;
  meta: ProjectMeta;
  /** For each media item, the paths to try in order (relative-to-project first). */
  mediaCandidates: Record<Id, string[]>;
}

/** Older file versions are upgraded here, one step at a time. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) throw new ProjectFileError('This project file has no valid version number.');
  if (version > PROJECT_VERSION) {
    throw new ProjectFileError('This project was saved by a newer version of SimpleCut. Please update the app to open it.');
  }
  // v1 → v2: only optional fields were added (audio, titles, transitions, beats), so a
  // version 1 file is read as-is.
  return { ...raw, version: PROJECT_VERSION };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const bool = (v: unknown) => v === true;

const TRANSITION_TYPES = ['dissolve', 'dipBlack', 'dipWhite', 'slide', 'crossfade'];
const ANIMATIONS = ['none', 'fade', 'slide', 'pop'];

function readTransition(v: unknown): Transition | undefined {
  if (!isObj(v) || !TRANSITION_TYPES.includes(str(v.type)) || !(num(v.duration) >= 1)) return undefined;
  return { type: v.type as Transition['type'], duration: Math.round(num(v.duration)) };
}

function readText(v: unknown): TextContent | undefined {
  if (!isObj(v)) return undefined;
  const d = DEFAULT_TEXT_STYLE;
  const color = (x: unknown, def: string) => (typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x) ? x : def);
  const unit = (x: unknown, def: number) => Math.min(1, Math.max(0, num(x, def)));
  return {
    content: str(v.content),
    ...(typeof v.preset === 'string' ? { preset: v.preset } : {}),
    font: str(v.font, d.font) || d.font,
    size: Math.min(600, Math.max(8, num(v.size, d.size))),
    color: color(v.color, d.color),
    bold: typeof v.bold === 'boolean' ? v.bold : d.bold,
    italic: bool(v.italic),
    align: v.align === 'left' || v.align === 'right' ? v.align : 'center',
    outlineColor: color(v.outlineColor, d.outlineColor),
    outlineWidth: Math.min(60, Math.max(0, num(v.outlineWidth, d.outlineWidth))),
    shadow: typeof v.shadow === 'boolean' ? v.shadow : d.shadow,
    shadowColor: color(v.shadowColor, d.shadowColor),
    shadowBlur: Math.min(100, Math.max(0, num(v.shadowBlur, d.shadowBlur))),
    shadowDistance: Math.min(100, Math.max(0, num(v.shadowDistance, d.shadowDistance))),
    box: bool(v.box),
    boxColor: color(v.boxColor, d.boxColor),
    boxOpacity: unit(v.boxOpacity, d.boxOpacity),
    boxPadding: Math.min(200, Math.max(0, num(v.boxPadding, d.boxPadding))),
    boxRadius: Math.min(200, Math.max(0, num(v.boxRadius, d.boxRadius))),
    x: unit(v.x, d.x),
    y: unit(v.y, d.y),
    animIn: (ANIMATIONS.includes(str(v.animIn)) ? v.animIn : d.animIn) as TextContent['animIn'],
    animOut: (ANIMATIONS.includes(str(v.animOut)) ? v.animOut : d.animOut) as TextContent['animOut'],
  };
}

function readClipExtras(c: Record<string, unknown>): Partial<Clip> {
  const out: Partial<Clip> = {};
  if (typeof c.volumeDb === 'number' && Number.isFinite(c.volumeDb) && c.volumeDb !== 0) out.volumeDb = Math.min(15, Math.max(-60, c.volumeDb));
  if (num(c.fadeIn) > 0) out.fadeIn = Math.round(num(c.fadeIn));
  if (num(c.fadeOut) > 0) out.fadeOut = Math.round(num(c.fadeOut));
  if (num(c.denoise) > 0) out.denoise = Math.min(1, num(c.denoise));
  const text = readText(c.text);
  if (text) out.text = text;
  const tin = readTransition(c.transitionIn);
  if (tin) out.transitionIn = tin;
  const tout = readTransition(c.transitionOut);
  if (tout) out.transitionOut = tout;
  if (num(c.speed, 1) !== 1 && num(c.speed) > 0) out.speed = Math.min(16, Math.max(0.1, num(c.speed)));
  if (isObj(c.transform)) out.transform = { ...DEFAULT_TRANSFORM, ...(c.transform as object) } as Transform;
  if (isObj(c.color)) out.color = { ...DEFAULT_GRADE, ...(c.color as object) } as ColorGrade;
  return out;
}

function readBeats(v: unknown): BeatAnalysis | undefined {
  if (!isObj(v) || !Array.isArray(v.beats)) return undefined;
  const times = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0) : []);
  return { music: bool(v.music), confidence: num(v.confidence), bpm: num(v.bpm), beats: times(v.beats), downbeats: times(v.downbeats) };
}

function readTimeline(raw: unknown): Timeline {
  if (!isObj(raw)) throw new ProjectFileError('The project file has no timeline.');
  const s = isObj(raw.settings) ? raw.settings : {};
  const format = str(s.format) in FORMATS ? (s.format as keyof typeof FORMATS) : '1080p';
  const fps = (FRAME_RATES as readonly number[]).includes(num(s.fps)) ? (num(s.fps) as FrameRate) : 30;
  const tracks: Track[] = (Array.isArray(raw.tracks) ? raw.tracks : []).filter(isObj).map((t) => ({
    id: str(t.id),
    kind: t.kind === 'audio' ? 'audio' : 'video',
    locked: bool(t.locked),
    muted: bool(t.muted),
    solo: bool(t.solo),
    hidden: bool(t.hidden),
    ...(typeof t.volumeDb === 'number' && Number.isFinite(t.volumeDb) && t.volumeDb !== 0 ? { volumeDb: t.volumeDb } : {}),
    ...(t.music === true ? { music: true } : {}),
    ...(t.captions === true ? { captions: true } : {}),
  }));
  // Keep the invariant: video tracks first, then audio.
  tracks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
  const trackIds = new Set(tracks.map((t) => t.id));
  const clips: Record<Id, Clip> = {};
  for (const c of Object.values(isObj(raw.clips) ? raw.clips : {}).filter(isObj)) {
    const id = str(c.id);
    if (!id || !trackIds.has(str(c.trackId))) continue;
    const clip: Clip = {
      id,
      trackId: str(c.trackId),
      mediaId: str(c.mediaId),
      kind: c.kind === 'audio' ? 'audio' : 'video',
      start: Math.max(0, Math.round(num(c.start))),
      duration: Math.max(1, Math.round(num(c.duration, 1))),
      sourceIn: Math.max(0, Math.round(num(c.sourceIn) * 1e6) / 1e6),
    };
    if (typeof c.linkId === 'string' && c.linkId) clip.linkId = c.linkId;
    if (typeof c.groupId === 'string' && c.groupId) clip.groupId = c.groupId;
    Object.assign(clip, readClipExtras(c));
    clips[id] = clip;
  }
  const markers: Marker[] = (Array.isArray(raw.markers) ? raw.markers : []).filter(isObj).map((m) => ({
    id: str(m.id),
    frame: Math.max(0, Math.round(num(m.frame))),
    label: str(m.label),
    color: (MARKER_COLORS as readonly string[]).includes(str(m.color)) ? (m.color as Marker['color']) : 'green',
    chapter: bool(m.chapter),
  }));
  const frameOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
  const target = (v: unknown) => (typeof v === 'string' && trackIds.has(v) ? v : null);
  return {
    settings: { format, fps, sampleRate: num(s.sampleRate, 48000), locked: bool(s.locked) },
    tracks,
    clips,
    markers,
    inPoint: frameOrNull(raw.inPoint),
    outPoint: frameOrNull(raw.outPoint),
    targetVideoTrackId: target(raw.targetVideoTrackId),
    targetAudioTrackId: target(raw.targetAudioTrackId),
    ...(typeof raw.masterGainDb === 'number' && Number.isFinite(raw.masterGainDb) ? { masterGainDb: raw.masterGainDb } : {}),
    ...(typeof raw.duckDb === 'number' && Number.isFinite(raw.duckDb) ? { duckDb: Math.min(0, raw.duckDb) } : {}),
    ...(isObj(raw.loudness) && Number.isFinite(raw.loudness.integratedLufs) && Number.isFinite(raw.loudness.truePeakDb)
      ? { loudness: { integratedLufs: raw.loudness.integratedLufs as number, truePeakDb: raw.loudness.truePeakDb as number } }
      : {}),
  };
}

/**
 * Parses a .scut file. `style` picks the path separator for the returned paths
 * (Windows backslashes on the desktop app).
 */
export function parseProject(text: string, projectFilePath: string | null, style: 'win32' | 'posix'): ParsedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError('This file is not a valid SimpleCut project (it is not readable JSON).');
  }
  if (!isObj(raw) || raw.format !== PROJECT_FORMAT) throw new ProjectFileError('This file is not a SimpleCut project.');
  const file = migrate(raw);
  const projectDir = projectFilePath ? dirname(toPortablePath(projectFilePath)) : null;
  const meta = isObj(file.project) ? file.project : {};
  const media: Record<Id, MediaItem> = {};
  const mediaCandidates: Record<Id, string[]> = {};
  for (const m of (Array.isArray(file.media) ? file.media : []).filter(isObj)) {
    const id = str(m.id);
    if (!id) continue;
    const candidates: string[] = [];
    if (projectDir && typeof m.path === 'string' && m.path) candidates.push(resolvePath(projectDir, m.path));
    if (typeof m.absolutePath === 'string' && m.absolutePath) candidates.push(toPortablePath(m.absolutePath));
    const unique = [...new Set(candidates)].map((p) => toNativePath(p, style));
    mediaCandidates[id] = unique;
    const { absolutePath: _a, path: _p, ...info } = m as unknown as MediaEntry;
    const { beats: rawBeats, ...rest } = info as Omit<MediaItem, 'path'> & { beats?: unknown };
    const beats = readBeats(rawBeats);
    media[id] = { ...rest, id, name: str(m.name, 'Media'), path: unique[0] ?? '', ...(beats ? { beats } : {}) };
  }
  const timeline = readTimeline(file.timeline);
  // Drop clips whose media entry is missing entirely (titles have no media).
  timeline.clips = Object.fromEntries(Object.entries(timeline.clips).filter(([, c]) => c.text || media[c.mediaId]));
  return {
    doc: { media, timeline },
    meta: { id: str(meta.id) || 'recovered', name: str(meta.name, 'Untitled') },
    mediaCandidates,
  };
}
