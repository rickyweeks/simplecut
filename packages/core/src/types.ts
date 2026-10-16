/**
 * SimpleCut timeline data model.
 *
 * Every position on the timeline is an integer number of frames at the timeline frame rate,
 * so cuts always land on frame boundaries. Ranges are half-open: [start, end).
 * All objects are treated as immutable: edit operations return new objects and never mutate.
 */

/** Integer frame count at the timeline frame rate. */
export type Frame = number;
export type Id = string;

export interface Range {
  start: Frame;
  /** Exclusive. */
  end: Frame;
}

// ---------------------------------------------------------------------------
// Timeline settings
// ---------------------------------------------------------------------------

export const FRAME_RATES = [24, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export type FormatPreset = '1080p' | '4k' | 'vertical';

export const FORMATS: Record<FormatPreset, { width: number; height: number; label: string }> = {
  '1080p': { width: 1920, height: 1080, label: '1080p · 16:9' },
  '4k': { width: 3840, height: 2160, label: '4K · 16:9' },
  vertical: { width: 1080, height: 1920, label: 'Vertical · 9:16' },
};

export interface TimelineSettings {
  format: FormatPreset;
  fps: FrameRate;
  /** Audio mix rate. Always 48 kHz (YouTube's native rate). */
  sampleRate: number;
  /**
   * False until the format is decided, either by the first video clip (auto-match)
   * or by the user. Auto-match only runs while this is false.
   */
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type MediaKind = 'video' | 'audio' | 'image';

/** What ffprobe told us about a file. Platform-neutral. */
export interface MediaInfo {
  kind: MediaKind;
  /** Seconds. 0 for still images (which can be stretched to any length). */
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Display size after rotation metadata is applied. 0 when there is no video. */
  width: number;
  height: number;
  /** Nominal frame rate (r_frame_rate). 0 when there is no video. */
  fps: number;
  /** Average frame rate (avg_frame_rate). Differs from fps on variable-frame-rate footage. */
  avgFps: number;
  /** Variable frame rate (typical for phones and some screen recorders). Conformed via proxy. */
  isVFR: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  pixFmt: string | null;
  /** Bits per second, 0 if unknown. */
  bitRate: number;
  audioChannels: number;
  audioSampleRate: number;
  /** Rotation from container metadata, degrees clockwise (0, 90, 180, 270). */
  rotation: number;
  fileSize: number;
}

export interface MediaItem extends MediaInfo {
  id: Id;
  /** Display name (file name by default). */
  name: string;
  /** Absolute path on this machine. Stored relative to the project file on disk. */
  path: string;
}

// ---------------------------------------------------------------------------
// Tracks and clips
// ---------------------------------------------------------------------------

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: Id;
  kind: TrackKind;
  /** Locked tracks are never changed by any edit. */
  locked: boolean;
  /** Audio: silence this track. */
  muted: boolean;
  /** Audio: when any track is soloed, only soloed tracks are heard. */
  solo: boolean;
  /** Video: exclude this track from the program output. */
  hidden: boolean;
}

export interface Clip {
  id: Id;
  trackId: Id;
  mediaId: Id;
  /** Which stream of the media this clip plays. Always equals its track's kind. */
  kind: TrackKind;
  /** Timeline frame where the clip starts (inclusive). */
  start: Frame;
  /** Length in frames (>= 1). */
  duration: Frame;
  /** Offset into the media, in timeline frames. Source time = sourceIn / fps seconds. */
  sourceIn: Frame;
  /** Clips that share a linkId (typically one video and one audio clip) move and trim together. */
  linkId?: Id;
  /** Clips that share a groupId are selected and moved together (Ctrl+G). */
  groupId?: Id;
}

// ---------------------------------------------------------------------------
// Markers and timeline
// ---------------------------------------------------------------------------

export const MARKER_COLORS = ['green', 'red', 'purple', 'orange', 'yellow', 'blue', 'cyan', 'white'] as const;
export type MarkerColor = (typeof MARKER_COLORS)[number];

export interface Marker {
  id: Id;
  frame: Frame;
  label: string;
  color: MarkerColor;
  /** Exported as a YouTube chapter timestamp (Phase 4). */
  chapter: boolean;
}

export interface Timeline {
  settings: TimelineSettings;
  /**
   * Video tracks in stacking order (V1 first, drawn at the bottom), followed by
   * audio tracks (A1 first). Use videoTracks()/audioTracks() to read them.
   */
  tracks: Track[];
  clips: Record<Id, Clip>;
  markers: Marker[];
  /** Timeline In mark (inclusive), or null. */
  inPoint: Frame | null;
  /** Timeline Out mark (inclusive, like Premiere), or null. */
  outPoint: Frame | null;
  /** Source patching: where insert/overwrite places video. Null = don't place video. */
  targetVideoTrackId: Id | null;
  /** Source patching: where insert/overwrite places audio. Null = don't place audio. */
  targetAudioTrackId: Id | null;
}

/** Everything that undo/redo covers. */
export interface ProjectDoc {
  media: Record<Id, MediaItem>;
  timeline: Timeline;
}
