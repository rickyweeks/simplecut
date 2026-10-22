import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { buildSpeechJob, parseWhisperJson, whisperArgs, type CaptionWord } from '@simplecut/core';
import type { CaptionModelStatus, CaptionProgress, TranscribeRequest } from '../shared/api';
import { audioSources } from './exporter';
import { CancelledError, binDir, run, runFfmpeg } from './ffmpeg';

/**
 * Auto captions run entirely on this PC: whisper.cpp (shipped with the app) and its English
 * speech model, which is downloaded once on first use (from the official whisper.cpp model
 * repository, checksum-verified) into the app's data folder.
 */

const MODEL = {
  file: 'ggml-base.en.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  bytes: 147_964_211,
  dtw: 'base.en',
};

const modelDir = () => join(app.getPath('userData'), 'models');
const modelPath = () => join(modelDir(), MODEL.file);
const whisperPath = () => join(binDir(), 'whisper', 'whisper-cli.exe');

let current: AbortController | null = null;

export function cancelCaptions(): void {
  current?.abort();
}

export async function modelStatus(): Promise<CaptionModelStatus> {
  const st = await fs.stat(modelPath()).catch(() => null);
  return { ready: !!st && st.size === MODEL.bytes, sizeBytes: MODEL.bytes };
}

/** Downloads the model to a .part file, verifies size and SHA-256, then moves it into place. */
export async function downloadModel(send: (e: CaptionProgress) => void): Promise<void> {
  if ((await modelStatus()).ready) return;
  if (current) throw new Error('Captions are already busy.');
  const controller = new AbortController();
  current = controller;
  await fs.mkdir(modelDir(), { recursive: true });
  const part = `${modelPath()}.part`;
  try {
    const res = await fetch(MODEL.url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}). Check your internet connection and try again.`);
    const total = Number(res.headers.get('content-length')) || MODEL.bytes;
    const hash = createHash('sha256');
    const file = createWriteStream(part);
    let got = 0;
    let last = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!file.write(value)) await new Promise<void>((r) => file.once('drain', () => r()));
        if (Date.now() - last > 200) {
          last = Date.now();
          send({ stage: 'download', fraction: Math.min(0.999, got / total) });
        }
      }
    } finally {
      await new Promise<void>((r) => file.end(() => r()));
    }
    if (got !== MODEL.bytes || hash.digest('hex') !== MODEL.sha256) throw new Error('The downloaded speech model is damaged (checksum mismatch). Please try again.');
    await fs.rename(part, modelPath());
    send({ stage: 'download', fraction: 1 });
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw new CancelledError();
    throw err;
  } finally {
    current = null;
  }
}

/** Mixes the timeline's speech (no music) to 16 kHz mono and transcribes it into timed words. */
export async function transcribe(req: TranscribeRequest, send: (e: CaptionProgress) => void): Promise<CaptionWord[]> {
  if (!(await modelStatus()).ready) throw new Error('The speech model is not downloaded yet.');
  if (!existsSync(whisperPath())) throw new Error('The captions engine is missing from this installation. Please reinstall SimpleCut.');
  if (current) throw new Error('Captions are already busy.');
  const controller = new AbortController();
  current = controller;
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'scut-captions-'));
  try {
    const fps = req.doc.timeline.settings.fps;
    const wav = join(tempDir, 'speech.wav');
    const audioPathFor = await audioSources(req.doc);
    const { job, files } = buildSpeechJob({ doc: req.doc, range: req.range, outputPath: wav, tempDir, audioPathFor });
    for (const f of files) await fs.writeFile(f.path, f.content, 'utf8');
    send({ stage: 'audio', fraction: 0 });
    await runFfmpeg(job.args, {
      signal: controller.signal,
      onProgress: (p) => send({ stage: 'audio', fraction: Math.min(1, p.outTimeSec / Math.max(0.1, job.durationSec)) }),
    });
    const outBase = join(tempDir, 'words');
    const threads = Math.max(2, Math.min(8, cpus().length - 1));
    send({ stage: 'transcribe', fraction: 0 });
    await run(whisperPath(), whisperArgs(modelPath(), wav, outBase, threads, MODEL.dtw), {
      signal: controller.signal,
      onStderr: (t) => {
        const m = /progress\s*=\s*(\d+)%/.exec(t);
        if (m) send({ stage: 'transcribe', fraction: Number(m[1]) / 100 });
      },
    });
    const json = await fs.readFile(`${outBase}.json`, 'utf8');
    return parseWhisperJson(json, req.range.start / fps);
  } finally {
    current = null;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
