import { defaultIds, type IdGen } from '../ids';
import { clearRange, setClips } from '../timeline/primitives';
import { isRangeEmpty, videoTracks } from '../timeline/query';
import { addTrack } from '../timeline/structure';
import { fadeInFactor, fadeOutFactor } from '../timeline/transitions';
import { TEXT_MEDIA_ID, type Clip, type Frame, type Id, type TextContent, type TextStyle, type Timeline } from '../types';

/**
 * Titles. The look is plain data (TextStyle); the app draws it into a transparent
 * full-frame image, which the preview composites and the export overlays, so both show
 * exactly the same pixels. Animations are simple presets, computed the same way for the
 * preview (textAnimState) and as FFmpeg filter expressions (textAnimationFilters).
 */

/** Fonts that ship with Windows 10/11. */
export const TEXT_FONTS = [
  'Segoe UI',
  'Segoe UI Black',
  'Bahnschrift',
  'Arial',
  'Arial Black',
  'Impact',
  'Trebuchet MS',
  'Verdana',
  'Georgia',
  'Times New Roman',
  'Consolas',
  'Comic Sans MS',
  'Segoe Script',
];

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'Segoe UI',
  size: 96,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  outlineColor: '#000000',
  outlineWidth: 0,
  shadow: true,
  shadowColor: '#000000',
  shadowBlur: 14,
  shadowDistance: 4,
  box: false,
  boxColor: '#000000',
  boxOpacity: 0.6,
  boxPadding: 24,
  boxRadius: 14,
  x: 0.5,
  y: 0.5,
  animIn: 'fade',
  animOut: 'fade',
};

export interface TextPreset {
  id: string;
  name: string;
  description: string;
  seconds: number;
  text: TextContent;
}

const preset = (id: string, name: string, description: string, seconds: number, content: string, style: Partial<TextStyle>): TextPreset => ({
  id,
  name,
  description,
  seconds,
  text: { ...DEFAULT_TEXT_STYLE, ...style, content, preset: id },
});

export const TEXT_PRESETS: TextPreset[] = [
  preset('big-title', 'Big Title', 'Large centered title that pops in', 4, 'Your Title', { font: 'Segoe UI Black', size: 150, animIn: 'pop' }),
  preset('lower-third', 'Lower Third', 'Name and role, bottom left', 5, 'Your Name\nCreator · @handle', {
    size: 52, align: 'left', x: 0.24, y: 0.83, box: true, boxColor: '#101114', boxOpacity: 0.82, boxPadding: 26, boxRadius: 10, shadow: false, animIn: 'slide', animOut: 'slide',
  }),
  preset('subscribe', 'Subscribe Callout', 'Bold red callout, bottom right', 4, 'SUBSCRIBE', {
    font: 'Segoe UI Black', size: 64, x: 0.83, y: 0.85, box: true, boxColor: '#e5202e', boxOpacity: 1, boxPadding: 26, boxRadius: 16, shadow: true, shadowBlur: 20, animIn: 'pop', animOut: 'fade',
  }),
  preset('chapter', 'Chapter Card', 'Full-screen chapter heading', 3, 'Chapter 1\nGetting Started', {
    size: 110, box: true, boxColor: '#000000', boxOpacity: 0.72, boxPadding: 48, boxRadius: 20, animIn: 'fade', animOut: 'fade',
  }),
  preset('caption', 'Caption Box', 'Subtitle-style text at the bottom', 3, 'Your caption goes here', {
    size: 54, bold: false, y: 0.88, box: true, boxColor: '#000000', boxOpacity: 0.65, boxPadding: 16, boxRadius: 8, shadow: false, animIn: 'fade', animOut: 'fade',
  }),
  preset('neon', 'Neon', 'Glowing title for gaming and FPV', 4, 'LET’S GO', {
    font: 'Bahnschrift', size: 140, color: '#7df9ff', shadowColor: '#00c8ff', shadowBlur: 36, shadowDistance: 0, animIn: 'pop', animOut: 'fade',
  }),
  preset('banner', 'Top Banner', 'Bold outlined text across the top', 4, 'EPIC MOMENT', {
    font: 'Impact', size: 100, bold: false, y: 0.13, outlineWidth: 8, outlineColor: '#000000', shadow: false, animIn: 'slide', animOut: 'slide',
  }),
  preset('quote', 'Quote', 'Elegant italic quote', 5, '“Make it simple.”', { font: 'Georgia', size: 76, bold: false, italic: true, animIn: 'fade', animOut: 'fade' }),
];

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

export const TEXT_ANIM_IN_SECONDS = 0.4;
export const TEXT_ANIM_OUT_SECONDS = 0.3;
/** Slide distance as a fraction of the frame width. */
const SLIDE = 0.06;

export function textAnimFrames(text: TextStyle, duration: Frame, fps: number): { nIn: Frame; nOut: Frame } {
  const half = Math.floor(duration / 2);
  return {
    nIn: text.animIn === 'none' ? 0 : Math.min(half, Math.round(TEXT_ANIM_IN_SECONDS * fps)),
    nOut: text.animOut === 'none' ? 0 : Math.min(half, Math.round(TEXT_ANIM_OUT_SECONDS * fps)),
  };
}

const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
const easeInCubic = (p: number) => p ** 3;
const easeOutBack = (p: number) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;

export interface TextAnimState {
  alpha: number;
  /** Horizontal offset, fraction of the frame width. */
  dx: number;
  /** Scale around the text's anchor point. */
  scale: number;
}

/** Animation state at frame `local` (0-based within the clip). */
export function textAnimState(text: TextStyle, local: Frame, duration: Frame, fps: number): TextAnimState {
  const { nIn, nOut } = textAnimFrames(text, duration, fps);
  const outStart = duration - nOut;
  const pin = nIn > 0 ? Math.min(1, local / nIn) : 1;
  const pout = nOut > 0 ? Math.min(1, Math.max(0, (local - outStart) / nOut)) : 0;
  let alpha = 1;
  if (nIn > 0) alpha *= fadeInFactor(local, nIn);
  if (nOut > 0 && local >= outStart) alpha *= fadeOutFactor(local - outStart, nOut);
  let dx = 0;
  if (text.animIn === 'slide') dx += -SLIDE * (1 - easeOutCubic(pin));
  if (text.animOut === 'slide') dx += SLIDE * easeInCubic(pout);
  let scale = 1;
  if (text.animIn === 'pop') scale *= 0.6 + 0.4 * easeOutBack(pin);
  if (text.animOut === 'pop') scale *= 1 - 0.3 * easeInCubic(pout);
  return { alpha, dx, scale };
}

/**
 * FFmpeg filters that animate a transparent full-frame title image (yuva420p) exactly like
 * textAnimState. Uses the frame number `n`, so it is frame-exact.
 */
export function textAnimationFilters(text: TextStyle, duration: Frame, fps: number, W: number, H: number): string[] {
  const { nIn, nOut } = textAnimFrames(text, duration, fps);
  const outStart = duration - nOut;
  const pin = nIn > 0 ? `min(1,n/${nIn})` : '1';
  const pout = nOut > 0 ? `clip((n-${outStart})/${nOut},0,1)` : '0';
  const filters: string[] = [];
  if (text.animIn === 'slide' || text.animOut === 'slide') {
    const terms: string[] = [];
    if (text.animIn === 'slide') terms.push(`-${SLIDE}*(1-(1-pow(1-${pin},3)))`);
    if (text.animOut === 'slide') terms.push(`${SLIDE}*pow(${pout},3)`);
    const m = Math.ceil(SLIDE * W) + 2;
    // Translate by padding with transparency and cropping at a moving offset.
    filters.push(`pad=${W + 2 * m}:${H}:${m}:0:color=black@0`, `crop=${W}:${H}:x='${m}-(${terms.join('+')})*${W}':y=0`);
  }
  if (text.animIn === 'pop' || text.animOut === 'pop') {
    const factors: string[] = [];
    if (text.animIn === 'pop') factors.push(`(0.6+0.4*(1+2.70158*pow(${pin}-1,3)+1.70158*pow(${pin}-1,2)))`);
    if (text.animOut === 'pop') factors.push(`(1-0.3*pow(${pout},3))`);
    const s = factors.join('*');
    const m = Math.ceil(0.15 * Math.max(W, H)) * 2;
    const cx = (text.x * W).toFixed(2);
    const cy = (text.y * H).toFixed(2);
    // Scale the whole frame around the text's anchor point, then put it back on a fixed canvas.
    filters.push(
      `scale=w='max(2,trunc(${W}*${s}/2)*2)':h='max(2,trunc(${H}*${s}/2)*2)':eval=frame`,
      `pad=w=${W + 2 * m}:h=${H + 2 * m}:x='${m}+${cx}*(1-iw/${W})':y='${m}+${cy}*(1-ih/${H})':color=black@0:eval=frame`,
      `crop=${W}:${H}:${m}:${m}`,
    );
  }
  if (nIn > 0) filters.push(`fade=t=in:s=0:n=${nIn}:alpha=1`);
  if (nOut > 0) filters.push(`fade=t=out:s=${outStart}:n=${nOut}:alpha=1`);
  return filters;
}

// ---------------------------------------------------------------------------
// Placing titles
// ---------------------------------------------------------------------------

export const isTextClip = (c: Pick<Clip, 'text'>): boolean => !!c.text;

/**
 * Adds a title at `at`. Uses the given video track, or the lowest track above V1 that is
 * free for the title's length (adding a track if needed), so titles sit over the footage.
 */
export function addTitle(
  tl: Timeline,
  text: TextContent,
  at: Frame,
  duration: Frame,
  opts: { trackId?: Id } = {},
  ids: IdGen = defaultIds,
): { timeline: Timeline; clipId: Id } {
  let out = tl;
  let trackId = opts.trackId;
  if (!trackId) {
    const candidates = videoTracks(out).slice(1).filter((t) => !t.locked);
    trackId = candidates.find((t) => isRangeEmpty(out, t.id, at, at + duration))?.id;
    if (!trackId) {
      out = addTrack(out, 'video', ids);
      trackId = videoTracks(out).at(-1)!.id;
    }
  }
  out = clearRange(out, [trackId], at, at + duration, ids);
  const clip: Clip = { id: ids(), trackId, mediaId: TEXT_MEDIA_ID, kind: 'video', start: at, duration: Math.max(1, duration), sourceIn: 0, text: { ...text } };
  return { timeline: setClips(out, [clip]), clipId: clip.id };
}

