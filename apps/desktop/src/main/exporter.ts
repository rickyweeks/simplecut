import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import {
  buildExportPlan,
  buildLoudnessJob,
  denoiseStep,
  overallProgress,
  parseLoudnorm,
  type Clip,
  type MediaItem,
  type ProjectDoc,
  type VideoEncoderId,
} from '@simplecut/core';
import type { ExportProgressEvent, ExportResult, ExportStartRequest, LoudnessRequest } from '../shared/api';
import { encoderDetector } from './encoders';
import { CancelledError, FfmpegError, runFfmpeg } from './ffmpeg';
import { denoisedAudio } from './media';

/**
 * Makes sure every noise-reduced audio file the edit needs exists, and returns a function
 * that maps a clip to the audio file to read (the cleaned file, or the original).
 */
async function audioSources(doc: ProjectDoc): Promise<(clip: Clip, media: MediaItem) => string> {
  const paths = new Map<string, string>();
  for (const c of Object.values(doc.timeline.clips)) {
    const m = doc.media[c.mediaId];
    if (!m || !c.denoise || c.kind !== 'audio') continue;
    const key = `${m.id}|${denoiseStep(c.denoise)}`;
    if (!paths.has(key)) paths.set(key, await denoisedAudio(m.path, m, c.denoise));
  }
  return (clip, media) => (clip.denoise ? (paths.get(`${media.id}|${denoiseStep(clip.denoise)}`) ?? media.path) : media.path);
}

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
  const textImages: Record<string, string> = {};
  for (const [clipId, png] of Object.entries(req.textImages ?? {})) {
    const file = join(tempDir, `title-${clipId.replace(/[^w-]/g, '_')}.png`);
    await fs.writeFile(file, png);
    textImages[clipId] = file;
  }
  const partial = join(dirname(req.outputPath), `.${basename(req.outputPath, extname(req.outputPath))}.simplecut-partial.mp4`);
  const hw = await encoderDetector.detect();
  const encoders: VideoEncoderId[] = req.encoder === 'software' || hw.length === 0 ? ['libx264'] : [hw[0]!, 'libx264'];
  // GPU decoding pays off for heavy sources (4K, HEVC…). Each input opens its own decoder,
  // so it is only used for moderately sized edits; the software retry decodes on the CPU.
  const heavySources = [...usedMedia].some((id) => {
    const m = req.doc.media[id];
    return m?.kind === 'video' && (Math.max(m.width, m.height) > 2560 || (m.videoCodec != null && m.videoCodec !== 'h264'));
  });
  const gpuDecode = heavySources && Object.keys(req.doc.timeline.clips).length <= 24;

  try {
    for (let i = 0; i < encoders.length; i++) {
      const encoder = encoders[i]!;
      try {
        const hwDecode = gpuDecode && encoder !== 'libx264';
        if (Object.values(req.doc.timeline.clips).some((c) => c.denoise)) {
          send({ fraction: 0, label: 'Reducing background noise', etaSec: null, bytesWritten: 0, encoder });
        }
        const audioPathFor = await audioSources(req.doc);
        const plan = buildExportPlan({
          doc: req.doc,
          range: req.range,
          outputPath: partial,
          encoder,
          tempDir,
          hwDecode,
          audioPathFor,
          textImages,
          duckRegions: req.duckRegions,
        });
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

/** Measures the mix's integrated loudness and true peak (before master gain). */
export async function measureLoudness(req: LoudnessRequest): Promise<{ integratedLufs: number; truePeakDb: number } | null> {
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'scut-loudness-'));
  try {
    const audioPathFor = await audioSources(req.doc);
    const { job, files } = buildLoudnessJob({ doc: req.doc, range: req.range, tempDir, audioPathFor, duckRegions: req.duckRegions });
    for (const f of files) await fs.writeFile(f.path, f.content, 'utf8');
    let stderr = '';
    await runFfmpeg(job.args, {
      onProgress: () => {},
      onStderr: (t) => {
        stderr = (stderr + t).slice(-20_000);
      },
    });
    return parseLoudnorm(stderr);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
