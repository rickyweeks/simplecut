import type { Clip, Id, TextContent, Timeline } from '../types';
import { setClips } from './primitives';
import { isTrackLocked, linkedClips } from './query';

/**
 * Paste Attributes (Ctrl+Alt+V): copy the look of one clip onto others. You choose which
 * groups to paste; each only goes onto clips it makes sense for (color onto video, audio
 * settings onto sound, text style onto titles).
 */

export type AttributeGroup = 'color' | 'audio' | 'transform' | 'textStyle';

export const ATTRIBUTE_LABELS: Record<AttributeGroup, string> = {
  color: 'Color',
  audio: 'Audio (volume, fades, noise reduction)',
  transform: 'Position, size and crop',
  textStyle: 'Text style',
};

/** Copied clips by role: the first video, audio and title clip among them. */
export interface AttributeSources {
  video?: Clip;
  audio?: Clip;
  text?: Clip;
}

export function attributeSources(copied: Clip[]): AttributeSources {
  return {
    video: copied.find((c) => c.kind === 'video' && !c.text),
    audio: copied.find((c) => c.kind === 'audio'),
    text: copied.find((c) => !!c.text),
  };
}

/** Which groups the copied clips have something to give for. */
export function availableAttributes(src: AttributeSources): AttributeGroup[] {
  const out: AttributeGroup[] = [];
  if (src.video) out.push('color', 'transform');
  if (src.audio) out.push('audio');
  if (src.text) out.push('textStyle');
  return out;
}

const AUDIO_KEYS = ['volumeDb', 'fadeIn', 'fadeOut', 'denoise'] as const;

function copyKeys<K extends keyof Clip>(target: Clip, from: Clip, keys: readonly K[]): Clip {
  const next: Clip = { ...target };
  for (const k of keys) {
    if (from[k] === undefined) delete next[k];
    else next[k] = from[k];
  }
  return next;
}

/** Pastes the chosen groups onto the targets (and their linked partners). */
export function pasteAttributes(tl: Timeline, src: AttributeSources, targetIds: Id[], groups: AttributeGroup[]): Timeline {
  const targets = new Map<Id, Clip>();
  for (const id of targetIds) {
    const c = tl.clips[id];
    if (!c) continue;
    targets.set(c.id, c);
    for (const p of linkedClips(tl, c)) targets.set(p.id, p);
  }
  const updates: Clip[] = [];
  for (const original of targets.values()) {
    if (isTrackLocked(tl, original.trackId)) continue;
    let c = original;
    if (c.kind === 'video' && !c.text && src.video && c.id !== src.video.id) {
      if (groups.includes('color')) c = copyKeys(c, src.video, ['color']);
      if (groups.includes('transform')) c = copyKeys(c, src.video, ['transform']);
    }
    if (c.kind === 'audio' && src.audio && c.id !== src.audio.id && groups.includes('audio')) c = copyKeys(c, src.audio, AUDIO_KEYS);
    if (c.text && src.text?.text && c.id !== src.text.id && groups.includes('textStyle')) {
      const { content: _content, ...style } = src.text.text;
      c = { ...c, text: { ...style, content: c.text.content } as TextContent };
    }
    if (c !== original) updates.push(c);
  }
  return updates.length ? setClips(tl, updates) : tl;
}
