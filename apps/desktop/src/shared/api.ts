/**
 * The contract between the Electron main process and the UI (exposed as `window.scut`).
 * Types only, shared by main, preload and renderer.
 */
import type { MediaAssetEvent, MediaInfo, ProjectDoc, Range, VideoEncoderId } from '@simplecut/core';

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
  };

  exporter: {
    encoders(): Promise<EncoderInfo>;
    start(req: ExportStartRequest): Promise<ExportResult>;
    cancel(): Promise<void>;
    onProgress(listener: (e: ExportProgressEvent) => void): () => void;
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
