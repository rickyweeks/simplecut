/**
 * Platform seams. Everything that touches the OS lives behind these small interfaces;
 * the Windows desktop app implements them with Node, Electron and FFmpeg. A future
 * Android app implements the same interfaces (e.g. with ffmpeg-kit and the Storage
 * Access Framework) and reuses the rest of this package unchanged.
 */
import type { ExportPlan } from './export/buildExport';
import type { VideoEncoderId } from './export/encoders';
import type { MediaInfo } from './types';

export interface ProjectStorage {
  readText(path: string): Promise<string>;
  /** Must be atomic: write to a temp file, then rename over the target. */
  writeText(path: string, text: string): Promise<void>;
  exists(paths: string[]): Promise<boolean[]>;
}

export interface MediaProber {
  probe(path: string): Promise<MediaInfo>;
}

/** Derived assets: proxies, waveforms, thumbnails. */
export interface MediaAssetEvent {
  path: string;
  kind: 'proxy' | 'waveform' | 'thumbnails' | 'poster';
  state: 'queued' | 'running' | 'ready' | 'failed';
  progress?: number;
  /** Location of the finished asset (proxy file, thumbnail folder, …). */
  output?: string;
  error?: string;
}

export interface MediaAssetService {
  /** Starts (or reuses cached) proxy, waveform and thumbnail generation for a file. */
  prepare(path: string, info: MediaInfo): void;
  onEvent(listener: (e: MediaAssetEvent) => void): () => void;
}

export interface EncoderDetector {
  /** Hardware encoders that passed a test encode, best first. libx264 is always available. */
  detect(): Promise<VideoEncoderId[]>;
}

export interface ExportProgress {
  /** 0..1 across all jobs. */
  fraction: number;
  label: string;
  /** Seconds remaining (estimate), or null while unknown. */
  etaSec: number | null;
  bytesWritten: number;
}

/** Structural subset of AbortSignal (kept DOM-free). */
export interface CancelSignal {
  readonly aborted: boolean;
}

export interface ExportRunner {
  run(plan: ExportPlan, onProgress: (p: ExportProgress) => void, signal: CancelSignal): Promise<void>;
}
