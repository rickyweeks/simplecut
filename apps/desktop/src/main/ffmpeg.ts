import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { ProgressParser, type FfmpegProgress } from '@simplecut/core';

/**
 * FFmpeg/ffprobe come from ffmpeg-static / ffprobe-static. scripts/prepare-bin.mjs copies
 * them into resources/bin, which electron-builder ships as extraResources (outside the
 * asar archive, so they can be executed).
 */
function binDir(): string {
  // Unpackaged, this file runs from out/main/, so resources/ is two levels up (independent
  // of how Electron was launched).
  return app.isPackaged ? join(process.resourcesPath, 'bin') : join(__dirname, '..', '..', 'resources', 'bin');
}

export function ffmpegPath(): string {
  return join(binDir(), 'ffmpeg.exe');
}

export function ffprobePath(): string {
  return join(binDir(), 'ffprobe.exe');
}

export function binariesPresent(): boolean {
  return existsSync(ffmpegPath()) && existsSync(ffprobePath());
}

const running = new Set<ChildProcess>();

/** Kills every FFmpeg we started (on quit). */
export function killAll(): void {
  for (const p of running) p.kill();
  running.clear();
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export interface RunOptions {
  /** Called for each -progress block (requires `-progress pipe:1` in args). */
  onProgress?: (p: FfmpegProgress) => void;
  /** Raw stdout (e.g. streamed PCM). Mutually exclusive with onProgress. */
  onStdout?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Runs a binary with arguments passed directly (no shell), so paths with spaces, non-ASCII
 * characters and long paths are handed to FFmpeg verbatim as UTF-16 via CreateProcessW.
 */
export function run(binary: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let stderr = '';
    let stdout = '';
    const parser = opts.onProgress ? new ProgressParser() : null;
    let timer: NodeJS.Timeout | undefined;
    let cancelled = false;

    child.stdout!.on('data', (chunk: Buffer) => {
      if (opts.onStdout) opts.onStdout(chunk);
      else if (parser) for (const p of parser.push(chunk.toString('utf8'))) opts.onProgress!(p);
      else stdout += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_000);
    });

    const onAbort = () => {
      cancelled = true;
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs);

    child.on('error', (err) => {
      running.delete(child);
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      running.delete(child);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) return reject(new CancelledError());
      if (code === 0) return resolve(stdout);
      const lastLines = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
      reject(new FfmpegError(lastLines || `FFmpeg exited with code ${code}`, code, stderr));
    });
  });
}

export const runFfmpeg = (args: string[], opts?: RunOptions) => run(ffmpegPath(), args, opts);
export const runFfprobe = (args: string[], opts?: RunOptions) => run(ffprobePath(), args, opts);
