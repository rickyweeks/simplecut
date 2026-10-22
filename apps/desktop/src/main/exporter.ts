import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import {
  buildExportPlan,
  buildFrameJob,
  buildLoudnessJob,
  denoiseStep,
  overallProgress,
  parseLoudnorm,
  type Clip,
  type CubeLut,
  type MediaItem,
  type ProjectDoc,
  type VideoEncoderId,
} from '@simplecut/core';
import type { ExportProgressEvent, ExportResult, ExportStartRequest, FrameRequest, LoudnessRequest } from '../shared/api';
import { encoderDetector } from './encoders';
import { CancelledError, FfmpegError, runFfmpeg } from './ffmpeg';
import { denoisedAudio, readLut } from './media';

/**
 * Makes sure every noise-reduced audio file the edit needs exists, and returns a function
 * that maps a clip to the audio file to read (the cleaned file, or the original).
 */
export async function audioSources(doc: ProjectDoc): Promise<(clip: Clip, media: MediaItem) => string> {
  const paths = new Map<string, string>();
  for (const c of Object.values(doc.timeline.clips)) {
    const m = doc.media[c.mediaId];
    if (!m || !c.denoise || c.kind !== 'audio') continue;
    const key = `${m.id}|${denoiseStep(c.denoise)}`;
    if (!paths.has(key)) paths.set(key, await denoisedAudio(m.path, m, c.denoise));
  }
  return (clip, media) => (clip.denoise ? (paths.get(`${media.id}|${denoiseStep(clip.denoise)}`) ?? media.path) : media.path);
}

/** Imported LUTs the edit's color grades use, read and parsed by path. */
async function inputLuts(doc: ProjectDoc): Promise<Record<string, CubeLut>> {
  const out: Record<string, CubeLut> = {};
  for (const c of Object.values(doc.timeline.clips)) {
    const lut = c.color?.lut;
    if (!lut || out[lut.path]) continue;
    try {
      out[lut.path] = await readLut(lut.path);
    } catch (err) {
      throw new Error(`The LUT "${lut.name}" could not be read (${err instanceof Error ? err.message : String(err)}). Relink or remove it in the Color section.`);
    }
  }
  return out;
}

/** Writes the UI-rendered images (titles, rounded-corner masks, borders) to the temp folder. */
async function writeImages(
  tempDir: string,
  textPngs: Record<string, Uint8Array> | undefined,
  clipPngs: Record<string, { mask?: Uint8Array; ring?: Uint8Array }> | undefined,
): Promise<{ textImages: Record<string, string>; clipImages: Record<string, { mask?: string; ring?: string }> }> {
  const safe = (id: string) => id.replace(/[^\w-]/g, '_');
  const textImages: Record<string, string> = {};
  for (const [clipId, png] of Object.entries(textPngs ?? {})) {
    const file = join(tempDir, `title-${safe(clipId)}.png`);
    await fs.writeFile(file, png);
    textImages[clipId] = file;
  }
  const clipImages: Record<string, { mask?: string; ring?: string }> = {};
  for (const [clipId, imgs] of Object.entries(clipPngs ?? {})) {
    const entry: { mask?: string; ring?: string } = {};
    for (const key of ['mask', 'ring'] as const) {
      const png = imgs[key];
      if (!png) continue;
      entry[key] = join(tempDir, `${key}-${safe(clipId)}.png`);
      await fs.writeFile(entry[key]!, png);
    }
    clipImages[clipId] = entry;
  }
  return { textImages, clipImages };
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
  const { textImages, clipImages } = await writeImages(tempDir, req.textImages, req.clipImages);
  // FFmpeg picks the container from the extension, so the partial file keeps the real one.
  const ext = extname(req.outputPath) || '.mp4';
  const partial = join(dirname(req.outputPath), `.${basename(req.outputPath, ext)}.simplecut-partial${ext}`);
  const hw = await encoderDetector.detect();
  const encoders: VideoEncoderId[] = req.audioOnly || req.encoder === 'software' || hw.length === 0 ? ['libx264'] : [hw[0]!, 'libx264'];
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
        const luts = await inputLuts(req.doc);
        const plan = buildExportPlan({
          doc: req.doc,
          range: req.range,
          outputPath: partial,
          encoder,
          tempDir,
          hwDecode,
          audioPathFor,
          textImages,
          clipImages,
          inputLuts: luts,
          output: req.output,
          audioOnly: req.audioOnly,
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
        if (req.srt) await fs.writeFile(join(dirname(req.outputPath), `${basename(req.outputPath, ext)}.srt`), req.srt, 'utf8');
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

/** Saves one program frame as a PNG, rendered by the export graph (so it is exactly the export's frame). */
export async function grabFrame(req: FrameRequest): Promise<ExportResult> {
  const started = Date.now();
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'scut-frame-'));
  try {
    const { textImages, clipImages } = await writeImages(tempDir, req.textImages, req.clipImages);
    const out = join(tempDir, 'frame.png');
    const { job, files } = buildFrameJob(
      { doc: req.doc, outputPath: out, tempDir, textImages, clipImages, inputLuts: await inputLuts(req.doc) },
      req.frame,
    );
    for (const f of files) await fs.writeFile(f.path, f.content, 'utf8');
    await runFfmpeg(job.args, { onProgress: () => {} });
    await fs.copyFile(out, req.outputPath);
    const bytes = (await fs.stat(req.outputPath)).size;
    return { ok: true, outputPath: req.outputPath, elapsedSec: (Date.now() - started) / 1000, bytes };
  } catch (err) {
    const message = err instanceof FfmpegError ? `FFmpeg could not render the frame.\n${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
