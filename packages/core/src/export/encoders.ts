/**
 * H.264 encoder choices. Hardware encoders are tried in this order and the first one that
 * passes a tiny test encode is used; libx264 (software) always works.
 */
export type VideoEncoderId = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';

export const HARDWARE_ENCODERS: VideoEncoderId[] = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

export const ENCODER_LABELS: Record<VideoEncoderId, string> = {
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync',
  h264_amf: 'AMD AMF',
  libx264: 'Software (x264)',
};

/** A 5-frame encode to null: proves the GPU, driver and FFmpeg build all support it. */
export function encoderTestArgs(id: VideoEncoderId): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30',
    '-frames:v', '5',
    ...(id === 'h264_qsv' || id === 'h264_amf' ? ['-pix_fmt', 'nv12'] : ['-pix_fmt', 'yuv420p']),
    '-c:v', id,
    '-f', 'null', '-',
  ];
}

export interface BitrateSpec {
  /** Target bits per second. */
  target: number;
  /** Peak bits per second. */
  max: number;
}

/**
 * YouTube's recommended upload bitrates (SDR):
 * 1080p 8 Mbps (12 at 48-60 fps), 4K 35-45 Mbps (53-68 at 48-60 fps).
 * Vertical 1080×1920 uses the 1080p numbers.
 */
export function youtubeBitrate(width: number, height: number, fps: number): BitrateSpec {
  const high = fps > 30;
  const pixels = width * height;
  const mbps = pixels > 2560 * 1440 ? (high ? 60 : 40) : pixels > 1920 * 1080 ? (high ? 24 : 16) : high ? 12 : 8;
  return { target: mbps * 1_000_000, max: Math.round(mbps * 1.5) * 1_000_000 };
}

export const YOUTUBE_AUDIO_BITRATE = 384_000;

const k = (bps: number) => `${Math.round(bps / 1000)}k`;

/** Encoder arguments for the final export (YouTube-friendly H.264 High profile, closed GOP of half a second). */
export function exportVideoArgs(id: VideoEncoderId, bitrate: BitrateSpec, fps: number): string[] {
  const gop = String(Math.max(1, Math.round(fps / 2)));
  const rate = ['-b:v', k(bitrate.target), '-maxrate', k(bitrate.max), '-bufsize', k(bitrate.max * 2)];
  const color = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  switch (id) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', ...rate, '-profile:v', 'high', '-g', gop, '-bf', '2', '-spatial_aq', '1', '-pix_fmt', 'yuv420p', ...color];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', ...rate, '-profile:v', 'high', '-g', gop, '-bf', '2', '-pix_fmt', 'nv12', ...color];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'vbr_peak', ...rate, '-profile:v', 'high', '-g', gop, '-pix_fmt', 'nv12', ...color];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'medium', ...rate, '-profile:v', 'high', '-g', gop, '-bf', '2', '-pix_fmt', 'yuv420p', ...color];
  }
}

/**
 * Encoder arguments for editing proxies: fast to make, fast to decode, every 10th frame a
 * keyframe and no B-frames so scrubbing and frame stepping are snappy.
 */
export function proxyVideoArgs(id: VideoEncoderId): string[] {
  const gop = ['-g', '10', '-bf', '0'];
  switch (id) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p2', '-rc', 'vbr', '-cq', '26', '-b:v', '0', ...gop, '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '26', ...gop, '-pix_fmt', 'nv12'];
    case 'h264_amf':
      // AMF's H.264 encoder emits no B-frames by default and rejects a bare -bf.
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '26', '-g', '10', '-pix_fmt', 'nv12'];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '23', ...gop, '-pix_fmt', 'yuv420p'];
  }
}
