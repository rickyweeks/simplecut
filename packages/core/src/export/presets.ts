import { FORMATS, type FormatPreset } from '../types';

/**
 * Export presets. Video presets render the timeline at a given size of the same shape (a
 * 16:9 edit can go out as 1080p or 4K; a Shorts edit as 1080x1920); audio presets export
 * the mix alone.
 */

export type ExportPresetId = 'timeline' | '4k' | '1080p' | 'shorts' | 'mp3' | 'wav';

export interface ExportPreset {
  id: ExportPresetId;
  name: string;
  kind: 'video' | 'audio';
  /** Output size for video presets. */
  size?: { width: number; height: number };
  extension: 'mp4' | 'mp3' | 'wav';
  /** Why it can't be used with this timeline (null = available). */
  unavailable: string | null;
}

export function exportPresets(format: FormatPreset): ExportPreset[] {
  const vertical = format === 'vertical';
  const t = FORMATS[format];
  const wide = vertical ? 'Turn Shorts mode off to export 16:9.' : null;
  return [
    { id: 'timeline', name: `YouTube · ${t.width}×${t.height}`, kind: 'video', size: { width: t.width, height: t.height }, extension: 'mp4', unavailable: null },
    { id: '4k', name: '4K · 3840×2160', kind: 'video', size: { width: 3840, height: 2160 }, extension: 'mp4', unavailable: wide },
    { id: '1080p', name: '1080p · 1920×1080', kind: 'video', size: { width: 1920, height: 1080 }, extension: 'mp4', unavailable: wide },
    { id: 'shorts', name: 'Shorts · 1080×1920', kind: 'video', size: { width: 1080, height: 1920 }, extension: 'mp4', unavailable: vertical ? null : 'Turn on Shorts mode (Inspector → YouTube) to export a vertical Short.' },
    { id: 'mp3', name: 'Audio · MP3', kind: 'audio', extension: 'mp3', unavailable: null },
    { id: 'wav', name: 'Audio · WAV', kind: 'audio', extension: 'wav', unavailable: null },
  ];
}

/** The size to pass as the export's `output` (undefined when it equals the timeline's). */
export function presetOutput(preset: ExportPreset, format: FormatPreset): { width: number; height: number } | undefined {
  const t = FORMATS[format];
  if (preset.kind !== 'video' || !preset.size || (preset.size.width === t.width && preset.size.height === t.height)) return undefined;
  return preset.size;
}
