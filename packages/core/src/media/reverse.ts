import { joinPath } from '../project/paths';
import { setClips } from '../timeline/primitives';
import { linkedClips, sourceSpan, tidy } from '../timeline/query';
import type { Clip, Id, MediaItem, Timeline } from '../types';

/**
 * Reverse: a reversed clip plays a reversed copy of the part of the source it uses (plus a
 * second of handle each side for trims and transitions). The copy is made in short chunks
 * (reverse needs every frame of what it reverses in memory) and joined; time t in the copy is
 * time outSec - t in the original. Reversing a reversed clip goes back to the original.
 */

export const REVERSE_HANDLE_SEC = 1;
const CHUNK_SEC = 2;
const SAMPLE_RATE = 48000;

/** The stretch of the original a clip needs reversed, in seconds. */
export function reverseRange(media: Pick<MediaItem, 'durationSec'>, clip: Pick<Clip, 'sourceIn' | 'duration' | 'speed'>, fps: number): { inSec: number; outSec: number } {
  const a = clip.sourceIn / fps;
  const b = (clip.sourceIn + sourceSpan(clip, clip.duration)) / fps;
  return { inSec: Math.max(0, a - REVERSE_HANDLE_SEC), outSec: Math.min(media.durationSec || b, b + REVERSE_HANDLE_SEC) };
}

export interface ReverseJob {
  args: string[];
  /** Seconds of output, for progress. */
  durationSec: number;
}

/** FFmpeg jobs that write the reversed copy of [inSec, outSec) of `media` to `outPath`. */
export function reverseJobs(media: MediaItem, inSec: number, outSec: number, tempDir: string, outPath: string): { jobs: ReverseJob[]; listPath: string; listText: string; temp: string[] } {
  const fps = media.fps > 0 ? Math.min(120, media.fps) : 30;
  const total = Math.max(1, Math.round((outSec - inSec) * fps));
  const chunk = Math.max(1, Math.round(CHUNK_SEC * fps));
  const jobs: ReverseJob[] = [];
  const temp: string[] = [];
  const lines = ['ffconcat version 1.0'];
  // Chunk i holds frames [total-(i+1)*chunk, total-i*chunk) reversed, so they join in order.
  for (let i = 0, end = total; end > 0; i++, end -= chunk) {
    const start = Math.max(0, end - chunk);
    const n = end - start;
    const name = `rev-part-${String(i).padStart(4, '0')}.mkv`;
    const out = joinPath(tempDir, name);
    temp.push(out);
    lines.push(`file '${name}'`);
    const ss = inSec + start / fps;
    const v = `fps=${fps},trim=end_frame=${n},setpts=PTS-STARTPTS,reverse,format=yuv420p`;
    const a = `aresample=${SAMPLE_RATE},atrim=end_sample=${Math.round((n / fps) * SAMPLE_RATE)},asetpts=PTS-STARTPTS,areverse`;
    jobs.push({
      durationSec: n / fps,
      args: [
        '-hide_banner', '-y', '-loglevel', 'error', '-nostdin',
        ...(ss > 0 ? ['-ss', ss.toFixed(6)] : []),
        '-t', ((n + 2) / fps).toFixed(6),
        '-i', media.path,
        '-map', '0:v:0', '-vf', v,
        ...(media.hasAudio ? ['-map', '0:a:0', '-af', a, '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2'] : []),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-g', String(Math.max(1, Math.round(fps / 2))), '-bf', '0',
        out,
      ],
    });
  }
  const listPath = joinPath(tempDir, 'rev-parts.ffconcat');
  temp.push(listPath);
  jobs.push({
    durationSec: total / fps,
    args: [
      '-hide_banner', '-y', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v:0', ...(media.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '320k'] : []),
      '-c:v', 'copy', '-movflags', '+faststart', outPath,
    ],
  });
  return { jobs, listPath, listText: lines.join('\n') + '\n', temp };
}

/**
 * Points a clip (and its linked partners using the same source) at the reversed copy, or
 * back at the original when it already plays a reversed copy.
 */
export function applyReverse(tl: Timeline, clipId: Id, original: MediaItem, target: MediaItem): Timeline {
  const clip = tl.clips[clipId];
  if (!clip) return tl;
  const fps = tl.settings.fps;
  const group = [clip, ...linkedClips(tl, clip).filter((p) => p.mediaId === clip.mediaId && p.start === clip.start && p.sourceIn === clip.sourceIn)];
  const updates = group.map((c) => {
    const span = sourceSpan(c, c.duration) / fps;
    const t = c.sourceIn / fps;
    // Forward: copy time = outSec - (original time of the clip's last frame).
    // Back: original time = derived.outSec - (copy time of the clip's last frame).
    const outSec = target.derived ? target.derived.outSec : original.derived!.outSec;
    const startSec = outSec - (t + span);
    return { ...c, mediaId: target.id, sourceIn: tidy(Math.max(0, startSec * fps)) };
  });
  return setClips(tl, updates);
}
