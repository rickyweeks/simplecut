/**
 * The contract between the Electron main process and the UI (exposed as `window.scut`).
 * Types only, shared by main, preload and renderer.
 */
import type { BeatAnalysis, CaptionWord, CubeLut, DuckRegion, MediaAssetEvent, MediaInfo, MediaItem, ProjectDoc, Range, SilenceSettings, VideoEncoderId } from '@simplecut/core';

export interface ThumbnailMeta {
  intervalSec: number;
  count: number;
  height: number;
}

/** Asset events from main also carry thumbnail details when thumbnails are ready. */
export interface AssetEvent extends MediaAssetEvent {
  thumbs?: ThumbnailMeta;
}

export interface RecoveryEntry {
  id: string;
  name: string;
  projectPath: string | null;
  savedAt: string;
}

export interface ExportStartRequest {
  doc: ProjectDoc;
  range: Range;
  outputPath: string;
  /** 'auto' = best detected hardware encoder, falling back to software. */
  encoder: 'auto' | 'software';
  /** Transparent full-frame PNG (bytes) per title clip, drawn by the UI exactly like the preview. */
  textImages?: Record<string, Uint8Array>;
  /** Where dialogue is; the music track ducks under it. */
  duckRegions?: DuckRegion[];
  /** Export preset size, when it differs from the timeline format. */
  output?: { width: number; height: number };
  /** Sound only (MP3 or WAV). */
  audioOnly?: 'mp3' | 'wav';
  /** Rounded-corner masks and borders (PNG bytes) per clip, drawn by the UI at the picture size. */
  clipImages?: Record<string, { mask?: Uint8Array; ring?: Uint8Array }>;
  /** Captions to save as an .srt next to the video. */
  srt?: string;
}

/** One program frame as a PNG (thumbnail grab). */
export interface FrameRequest {
  doc: ProjectDoc;
  frame: number;
  outputPath: string;
  textImages?: Record<string, Uint8Array>;
  clipImages?: Record<string, { mask?: Uint8Array; ring?: Uint8Array }>;
}

export interface SilenceRequest {
  path: string;
  /** Part of the file to analyse (the clip's source range). */
  startSec: number;
  durationSec: number;
  settings: SilenceSettings;
}

export interface CaptionModelStatus {
  ready: boolean;
  /** Download size of the speech model. */
  sizeBytes: number;
}

export interface CaptionProgress {
  stage: 'download' | 'audio' | 'transcribe';
  /** 0..1, or null when unknown. */
  fraction: number | null;
}

export interface TranscribeRequest {
  doc: ProjectDoc;
  range: Range;
}

export interface LoudnessRequest {
  doc: ProjectDoc;
  range: Range;
  duckRegions?: DuckRegion[];
}

export interface ExportProgressEvent {
  fraction: number;
  label: string;
  etaSec: number | null;
  bytesWritten: number;
  encoder: VideoEncoderId;
}

export interface ExportResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  outputPath?: string;
  encoder?: VideoEncoderId;
  elapsedSec?: number;
  bytes?: number;
}

export interface EncoderInfo {
  available: VideoEncoderId[];
  preferred: VideoEncoderId;
}

export interface ConfirmOptions {
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface ScutApi {
  versions: { app: string; electron: string; chrome: string };
  /** Absolute path of a file dropped from the OS. */
  pathForFile(file: File): string;
  /** URL the renderer can load a local file from (supports seeking). */
  mediaUrl(path: string): string;

  dialogs: {
    openMedia(): Promise<string[]>;
    openProject(): Promise<string | null>;
    saveProject(defaultName: string): Promise<string | null>;
    exportVideo(defaultName: string): Promise<string | null>;
    locateMedia(fileName: string): Promise<string | null>;
    confirm(opts: ConfirmOptions): Promise<number>;
    /** Picks a .cube LUT. */
    openLut(): Promise<string | null>;
    /** A save dialog for any file type (PNG thumbnails, MP3/WAV, .srt…). */
    saveFile(opts: { title: string; defaultName: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>;
  };

  project: {
    read(path: string): Promise<string>;
    /** Atomic write (temp file + rename). */
    write(path: string, text: string): Promise<void>;
    exists(paths: string[]): Promise<boolean[]>;
    /** Looks for files by name in a folder (and two levels below). Returns name → path. */
    findInFolder(folder: string, fileNames: string[]): Promise<Record<string, string>>;
  };

  recovery: {
    write(id: string, text: string, meta: { name: string; projectPath: string | null }): Promise<void>;
    list(): Promise<RecoveryEntry[]>;
    read(id: string): Promise<string>;
    clear(id: string): Promise<void>;
  };

  media: {
    probe(path: string): Promise<MediaInfo>;
    /** Starts background poster/waveform/thumbnail/proxy work (cached on disk). */
    prepare(path: string, info: MediaInfo, opts?: { forceProxy?: boolean }): Promise<void>;
    onAsset(listener: (e: AssetEvent) => void): () => void;
    /** Beats of a song (analysed once, cached). */
    analyzeBeats(path: string): Promise<BeatAnalysis>;
    /** Path of the noise-reduced version of a file's audio (made once per strength, cached). */
    denoise(path: string, info: MediaInfo, strength: number): Promise<string>;
    /** Path of a reversed copy of [inSec, outSec) of a file (made once, cached). */
    reverse(media: MediaItem, inSec: number, outSec: number): Promise<string>;
    /** Pauses in part of a file's audio, in seconds from startSec. */
    silences(req: SilenceRequest): Promise<{ start: number; end: number }[]>;
    /** Small RGB samples (64x36 each) of a file's picture at the given times, for Auto Color. */
    colorSamples(path: string, times: number[]): Promise<Uint8Array>;
    /** Reads a .cube LUT file. */
    readLut(path: string): Promise<CubeLut>;
  };

  captions: {
    modelStatus(): Promise<CaptionModelStatus>;
    /** Downloads the speech model (once, checksum-verified). */
    downloadModel(): Promise<void>;
    /** The timeline's speech as timed words. */
    transcribe(req: TranscribeRequest): Promise<CaptionWord[]>;
    cancel(): Promise<void>;
    onProgress(listener: (e: CaptionProgress) => void): () => void;
  };

  exporter: {
    encoders(): Promise<EncoderInfo>;
    start(req: ExportStartRequest): Promise<ExportResult>;
    cancel(): Promise<void>;
    onProgress(listener: (e: ExportProgressEvent) => void): () => void;
    /** Integrated loudness / true peak of the mix (before master gain), or null. */
    measureLoudness(req: LoudnessRequest): Promise<{ integratedLufs: number; truePeakDb: number } | null>;
    /** Saves one program frame as a PNG. */
    frame(req: FrameRequest): Promise<ExportResult>;
  };

  shell: {
    showItemInFolder(path: string): void;
  };

  app: {
    setTitle(title: string): void;
    /** The window is about to close; call confirmClose() to let it. */
    onCloseRequest(listener: () => void): () => void;
    confirmClose(): void;
    /** A .scut file was opened from Explorer while the app is running. */
    onOpenFile(listener: (path: string) => void): () => void;
    /** A .scut file passed on the command line at launch, if any. */
    launchFile(): Promise<string | null>;
  };
}

export const IPC = {
  dialogOpenMedia: 'dialog:open-media',
  dialogOpenProject: 'dialog:open-project',
  dialogSaveProject: 'dialog:save-project',
  dialogExportVideo: 'dialog:export-video',
  dialogLocateMedia: 'dialog:locate-media',
  dialogConfirm: 'dialog:confirm',
  dialogOpenLut: 'dialog:open-lut',
  dialogSaveFile: 'dialog:save-file',
  projectRead: 'project:read',
  projectWrite: 'project:write',
  projectExists: 'project:exists',
  projectFindInFolder: 'project:find-in-folder',
  recoveryWrite: 'recovery:write',
  recoveryList: 'recovery:list',
  recoveryRead: 'recovery:read',
  recoveryClear: 'recovery:clear',
  mediaProbe: 'media:probe',
  mediaPrepare: 'media:prepare',
  mediaAsset: 'media:asset',
  mediaBeats: 'media:beats',
  mediaDenoise: 'media:denoise',
  mediaReverse: 'media:reverse',
  mediaSilences: 'media:silences',
  mediaColorSamples: 'media:color-samples',
  mediaReadLut: 'media:read-lut',
  captionsStatus: 'captions:status',
  captionsDownload: 'captions:download',
  captionsTranscribe: 'captions:transcribe',
  captionsCancel: 'captions:cancel',
  captionsProgress: 'captions:progress',
  exportFrame: 'export:frame',
  exportLoudness: 'export:loudness',
  exportEncoders: 'export:encoders',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress',
  shellShowItem: 'shell:show-item',
  appSetTitle: 'app:set-title',
  appCloseRequest: 'app:close-request',
  appConfirmClose: 'app:confirm-close',
  appOpenFile: 'app:open-file',
  appLaunchFile: 'app:launch-file',
} as const;

export const MEDIA_SCHEME = 'scut';

/** Must match the protocol handler in main. */
export function mediaUrlFor(path: string): string {
  return `${MEDIA_SCHEME}://media/${encodeURIComponent(path)}`;
}
