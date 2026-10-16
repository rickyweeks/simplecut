import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { buildExportPlan, overallProgress, type VideoEncoderId } from '@simplecut/core';
import type { ExportProgressEvent, ExportResult, ExportStartRequest } from '../shared/api';
import { encoderDetector } from './encoders';
import { CancelledError, FfmpegError, runFfmpeg } from './ffmpeg';

let current: AbortController | null = null;

export function cancelExport(): void {
  current?.abort();
}

/**
 * Renders the timeline with FFmpeg. Uses the best hardware encoder that passed detection
 * and automatically retries with software x264 if the GPU encode fails. Writes to a
 * temporary file next to the target and renames it at the end, so a failed or cancelled
 * export never leaves a broken file (or clobbers an existing one).
 */
export async function startExport(req: ExportStartRequest, send: (e: ExportProgressEvent) => void): Promise<ExportResult> {
  if (current) return { ok: false, error: 'An export is already running.' };
  const controller = new AbortController();
  current = controller;
  const started = Date.now();

  const usedMedia = new Set(Object.values(req.doc.timeline.clips).map((c) => c.mediaId));
  const offline = [...usedMedia]
    .map((id) => req.doc.media[id])
    .filter((m) => m && !existsSync(m.path))
    .map((m) => m!.name);
  if (offline.length) {
    current = null;
    return { ok: false, error: `Some media files are missing: ${offline.join(', ')}. Relink them before exporting.` };
  }

  const tempDir = await fs.mkdtemp(join(tmpdir(), 'scut-export-'));
  const partial = join(dirname(req.outputPath), `.${basename(req.outputPath, extname(req.outputPath))}.simplecut-partial.mp4`);
  const hw = await encoderDetector.detect();
  const encoders: VideoEncoderId[] = req.encoder === 'software' || hw.length === 0 ? ['libx264'] : [hw[0]!, 'libx264'];

  try {
    for (let i = 0; i < encoders.length; i++) {
      const encoder = encoders[i]!;
      try {
        const plan = buildExportPlan({ doc: req.doc, range: req.range, outputPath: partial, encoder, tempDir, hwDecode: false });
        for (const f of plan.files) await fs.writeFile(f.path, f.content, 'utf8');
        const durations = plan.jobs.map((j) => j.durationSec);
        send({ fraction: 0, label: plan.jobs[0]!.label, etaSec: null, bytesWritten: 0, encoder });
        for (let j = 0; j < plan.jobs.length; j++) {
          const job = plan.jobs[j]!;
          await runFfmpeg(job.args, {
            signal: controller.signal,
            onProgress: (p) => {
              const fraction = overallProgress(durations, j, p.outTimeSec);
              const elapsed = (Date.now() - started) / 1000;
              const etaSec = fraction > 0.02 ? (elapsed * (1 - fraction)) / fraction : null;
              send({ fraction, label: job.label, etaSec, bytesWritten: p.totalSizeBytes, encoder });
            },
          });
        }
        await fs.rename(partial, req.outputPath);
        const bytes = (await fs.stat(req.outputPath)).size;
        return { ok: true, outputPath: req.outputPath, encoder, elapsedSec: (Date.now() - started) / 1000, bytes };
      } catch (err) {
        if (err instanceof CancelledError || i === encoders.length - 1) throw err;
        console.warn(`[export] ${encoder} failed, retrying with software:`, err instanceof Error ? err.message : err);
        send({ fraction: 0, label: 'Hardware encoder failed — retrying with software', etaSec: null, bytesWritten: 0, encoder: 'libx264' });
      }
    }
    throw new Error('unreachable');
  } catch (err) {
    if (err instanceof CancelledError) return { ok: false, cancelled: true };
    const message = err instanceof FfmpegError ? `FFmpeg could not render the video.\n${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    current = null;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(partial, { force: true }).catch(() => {});
  }
}
