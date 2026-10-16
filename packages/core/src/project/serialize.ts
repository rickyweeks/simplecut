import {
  FORMATS,
  FRAME_RATES,
  MARKER_COLORS,
  type Clip,
  type FrameRate,
  type Id,
  type Marker,
  type MediaItem,
  type ProjectDoc,
  type Timeline,
  type Track,
} from '../types';
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
export const PROJECT_VERSION = 1;
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
  // (No migrations yet: version 1 is the first format.)
  return raw;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const bool = (v: unknown) => v === true;

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
      sourceIn: Math.max(0, Math.round(num(c.sourceIn))),
    };
    if (typeof c.linkId === 'string' && c.linkId) clip.linkId = c.linkId;
    if (typeof c.groupId === 'string' && c.groupId) clip.groupId = c.groupId;
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
    media[id] = { ...(info as Omit<MediaItem, 'path'>), id, name: str(m.name, 'Media'), path: unique[0] ?? '' };
  }
  const timeline = readTimeline(file.timeline);
  // Drop clips whose media entry is missing entirely.
  timeline.clips = Object.fromEntries(Object.entries(timeline.clips).filter(([, c]) => media[c.mediaId]));
  return {
    doc: { media, timeline },
    meta: { id: str(meta.id) || 'recovered', name: str(meta.name, 'Untitled') },
    mediaCandidates,
  };
}
