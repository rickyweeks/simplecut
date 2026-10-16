import { HARDWARE_ENCODERS, encoderTestArgs, type EncoderDetector, type VideoEncoderId } from '@simplecut/core';
import type { EncoderInfo } from '../shared/api';
import { runFfmpeg } from './ffmpeg';

/**
 * Detects NVIDIA NVENC, Intel Quick Sync and AMD AMF by running a tiny test encode with
 * each (a listed encoder is not proof: the GPU and driver must support it too).
 * Runs once per app session.
 */
let detection: Promise<VideoEncoderId[]> | null = null;

export const encoderDetector: EncoderDetector = {
  detect() {
    detection ??= Promise.all(
      HARDWARE_ENCODERS.map((id) =>
        runFfmpeg(encoderTestArgs(id), { timeoutMs: 15_000 }).then(
          () => id,
          () => null,
        ),
      ),
    ).then((results) => results.filter((r): r is VideoEncoderId => r !== null));
    return detection;
  },
};

export async function encoderInfo(): Promise<EncoderInfo> {
  const hw = await encoderDetector.detect();
  return { available: [...hw, 'libx264'], preferred: hw[0] ?? 'libx264' };
}
