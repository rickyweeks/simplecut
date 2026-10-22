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

/** Result of beat analysis on a media file's audio. Times are seconds into the media. */
export interface BeatAnalysis {
  /** Steady, rhythmic material (music) rather than speech, ambience or game sound. */
  music: boolean;
  /** How clear the pulse is, 0..1. */
  confidence: number;
  bpm: number;
  beats: number[];
  /** The first beat of each bar (assuming 4/4). */
  downbeats: number[];
}

export interface MediaItem extends MediaInfo {
  id: Id;
  /** Display name (file name by default). */
  name: string;
  /** Absolute path on this machine. Stored relative to the project file on disk. */
  path: string;
  /** Present once the audio has been analysed for beats. */
  beats?: BeatAnalysis;
  /** A file SimpleCut made from another media item (e.g. a reversed copy of part of it). */
  derived?: DerivedMedia;
}

/**
 * A reversed copy of [inSec, outSec) of another media item: time t in this file is time
 * outSec - t in the original. Kept in the media cache; rebuilt from the original if missing.
 */
export interface DerivedMedia {
  from: Id;
  op: 'reverse';
  inSec: number;
  outSec: number;
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
  /** Audio: track volume in dB (0 = unchanged). */
  volumeDb?: number;
  /**
   * Audio: the music track ("Add music"). Its clips get beat markers and beat snapping, and
   * it automatically ducks under dialogue on the other tracks.
   */
  music?: boolean;
  /** Video: the captions track (auto captions live here; exported as .srt). */
  captions?: boolean;
}

/**
 * Transitions live on clips. `transitionIn` on a clip that directly follows another clip
 * on its track is a two-sided transition across that cut; with nothing before it, it fades
 * the clip in. `transitionOut` only applies when nothing directly follows the clip.
 */
export type VideoTransitionType = 'dissolve' | 'dipBlack' | 'dipWhite' | 'slide';
export type TransitionType = VideoTransitionType | 'crossfade';

export interface Transition {
  type: TransitionType;
  /** Length in frames, centered on the cut for two-sided transitions. */
  duration: Frame;
}

export type TextAnimation = 'none' | 'fade' | 'slide' | 'pop';
export type TextAlign = 'left' | 'center' | 'right';

/** Everything about how a title looks. Sizes are pixels at 1080p and scale with the frame. */
export interface TextStyle {
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  outlineColor: string;
  /** 0 = no outline. */
  outlineWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowDistance: number;
  box: boolean;
  boxColor: string;
  boxOpacity: number;
  boxPadding: number;
  boxRadius: number;
  /** Center of the text block, as a fraction of the frame (0..1). */
  x: number;
  y: number;
  animIn: TextAnimation;
  animOut: TextAnimation;
}

export interface TextContent extends TextStyle {
  content: string;
  /** Which preset it started from (informational). */
  preset?: string;
}

/**
 * Where a clip's picture sits in the frame. At the defaults the picture is fitted
 * (letterboxed) and centered, exactly as in Phase 1. Crop removes edges without moving
 * what's left (like Premiere); rotation and zoom pivot on the picture's center.
 */
export interface Transform {
  /** Center of the picture as a fraction of the frame. */
  x: number;
  y: number;
  /** 1 = the size that fits (or fills) the frame. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** Fractions of the source picture removed from each edge. */
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  /** 0..1. */
  opacity: number;
  /** 'fit' letterboxes the whole picture; 'fill' covers the frame (center crop, used for Shorts). */
  fit: 'fit' | 'fill';
  /** Rounded corners: radius as a fraction of the picture's shorter side (0..0.5). */
  radius: number;
  /** Border drawn just inside the picture edge, in pixels at 1080p (0 = none). */
  borderWidth: number;
  borderColor: string;
  /** Smooth zoom: when set, the scale moves from `scale` at the first frame to this at the last. */
  zoomTo?: number;
}

export type LookId = 'none' | 'warm' | 'cool' | 'punchy' | 'film' | 'tealOrange' | 'vintage' | 'moody' | 'bw';

/** Color correction. All zero / 'none' = untouched. */
export interface ColorGrade {
  /** Stops, -3..3. */
  exposure: number;
  /** -100..100. */
  contrast: number;
  /** -100 (black and white) .. 100. */
  saturation: number;
  /** -100 (cooler / blue) .. 100 (warmer / orange). */
  temperature: number;
  /** -100 (green) .. 100 (magenta). */
  tint: number;
  look: LookId;
  /** How strongly the look applies, 0..1. */
  lookAmount: number;
  /** An imported .cube LUT, applied first (e.g. to turn log footage into normal-looking video). */
  lut?: { path: string; name: string };
}

/** Clips that are titles have no media; their mediaId is this value. */
export const TEXT_MEDIA_ID = '';

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
  /** Audio: clip volume in dB (0 = unchanged). */
  volumeDb?: number;
  /** Audio: fade-in / fade-out lengths in frames. */
  fadeIn?: Frame;
  fadeOut?: Frame;
  /** Audio: background-noise reduction strength, 0 (off) .. 1. */
  denoise?: number;
  /** Present on title clips (video tracks only). */
  text?: TextContent;
  /**
   * Playback speed (1 = normal; 2 = twice as fast). Audio keeps its pitch. Source time at
   * timeline frame f is (sourceIn + (f - start) * speed) / fps, so sourceIn may be fractional.
   */
  speed?: number;
  /** Video: position, size, rotation, crop, opacity, corners and border. */
  transform?: Transform;
  /** Video: color correction. */
  color?: ColorGrade;
  transitionIn?: Transition;
  transitionOut?: Transition;
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
  /** Gain applied to the whole mix in dB (set by "Normalize loudness"). */
  masterGainDb?: number;
  /** Last loudness measurement of the mix (before master gain), LUFS / dBTP. */
  loudness?: { integratedLufs: number; truePeakDb: number };
  /** How far music tracks duck under dialogue, in dB (negative; 0 turns ducking off). */
  duckDb?: number;
}

/** Everything that undo/redo covers. */
export interface ProjectDoc {
  media: Record<Id, MediaItem>;
  timeline: Timeline;
}
