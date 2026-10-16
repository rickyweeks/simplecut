/** One `-progress` block from FFmpeg. */
export interface FfmpegProgress {
  outTimeSec: number;
  totalSizeBytes: number;
  speed: number;
  done: boolean;
}

/**
 * Parses FFmpeg's `-progress pipe:1` key=value stream. Feed it chunks as they arrive;
 * it returns a progress record each time a block ends (`progress=continue|end`).
 */
export class ProgressParser {
  private buffer = '';
  private current: Record<string, string> = {};

  push(chunk: string): FfmpegProgress[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    const out: FfmpegProgress[] = [];
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      this.current[key] = value;
      if (key === 'progress') {
        out.push(this.toProgress(value === 'end'));
        this.current = {};
      }
    }
    return out;
  }

  private toProgress(done: boolean): FfmpegProgress {
    const c = this.current;
    // out_time_us is microseconds (out_time_ms is too, despite its name); either may be N/A.
    const us = Number(c.out_time_us ?? c.out_time_ms);
    const size = Number(c.total_size);
    const speed = Number.parseFloat(c.speed ?? '');
    return {
      outTimeSec: Number.isFinite(us) && us > 0 ? us / 1e6 : 0,
      totalSizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
      speed: Number.isFinite(speed) ? speed : 0,
      done,
    };
  }
}

/** Overall progress across sequential jobs, weighted by output duration. */
export function overallProgress(jobDurations: number[], jobIndex: number, jobOutTimeSec: number): number {
  const total = jobDurations.reduce((a, b) => a + b, 0) || 1;
  const before = jobDurations.slice(0, jobIndex).reduce((a, b) => a + b, 0);
  const inJob = Math.min(jobOutTimeSec, jobDurations[jobIndex] ?? 0);
  return Math.max(0, Math.min(1, (before + inJob) / total));
}
