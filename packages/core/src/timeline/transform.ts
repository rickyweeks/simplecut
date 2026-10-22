import { FORMATS, type Clip, type FormatPreset, type Id, type MediaItem, type Timeline, type Transform } from '../types';
import { setClips } from './primitives';
import { isTrackLocked } from './query';

/**
 * Clip transforms: where a clip's picture sits in the frame. The geometry here is used by
 * both the preview compositor and the export graph, so they place pictures identically.
 */

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  opacity: 1,
  fit: 'fit',
  radius: 0,
  borderWidth: 0,
  borderColor: '#ffffff',
};

export const transformOf = (c: Pick<Clip, 'transform'>): Transform => c.transform ?? DEFAULT_TRANSFORM;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** True when the clip is drawn exactly like an untransformed Phase 1 clip (fitted, centered). */
export function isIdentityTransform(t: Transform | undefined): boolean {
  if (!t) return true;
  return (
    near(t.x, 0.5) &&
    near(t.y, 0.5) &&
    near(t.scale, 1) &&
    near(t.rotation % 360, 0) &&
    !t.cropLeft &&
    !t.cropTop &&
    !t.cropRight &&
    !t.cropBottom &&
    near(t.opacity, 1) &&
    t.fit === 'fit' &&
    !t.radius &&
    !t.borderWidth &&
    (t.zoomTo == null || near(t.zoomTo, t.scale))
  );
}

export const hasZoom = (t: Transform | undefined): boolean => !!t && t.zoomTo != null && !near(t.zoomTo, t.scale);

/** Scale at frame `i` of a clip `duration` frames long (smooth zoom eases in and out). */
export function zoomScaleAt(t: Transform, i: number, duration: number): number {
  if (!hasZoom(t)) return t.scale;
  const p = duration > 1 ? Math.min(1, Math.max(0, i / (duration - 1))) : 0;
  const e = p * p * (3 - 2 * p);
  return t.scale + (t.zoomTo! - t.scale) * e;
}

export interface PictureGeometry {
  /** The whole (uncropped) picture in output pixels. */
  pw: number;
  ph: number;
  /** The visible part inside the picture: offset and size in output pixels. */
  left: number;
  top: number;
  cw: number;
  ch: number;
  /** The visible part of the source, as fractions of the source picture. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Center of the picture in the frame, output pixels. */
  cx: number;
  cy: number;
  rotation: number;
  opacity: number;
  /** Corner radius and border width in output pixels. */
  radius: number;
  border: number;
  borderColor: string;
}

/**
 * Where a source picture (srcW x srcH, already upright) lands in a W x H frame. Sizes are
 * whole pixels so the export can scale to exactly them; `scale` overrides the transform's
 * own (used for the base of a smooth zoom).
 */
export function pictureGeometry(t: Transform, srcW: number, srcH: number, W: number, H: number, scale = t.scale): PictureGeometry {
  const fitScale = t.fit === 'fill' ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH);
  const pw = Math.max(2, Math.round(srcW * fitScale * scale));
  const ph = Math.max(2, Math.round(srcH * fitScale * scale));
  const cl = Math.min(0.95, Math.max(0, t.cropLeft));
  const cr = Math.min(0.95 - cl, Math.max(0, t.cropRight));
  const ct = Math.min(0.95, Math.max(0, t.cropTop));
  const cb = Math.min(0.95 - ct, Math.max(0, t.cropBottom));
  const left = Math.round(cl * pw);
  const top = Math.round(ct * ph);
  const cw = Math.max(1, pw - left - Math.round(cr * pw));
  const ch = Math.max(1, ph - top - Math.round(cb * ph));
  const unit = Math.min(W, H) / 1080;
  return {
    pw,
    ph,
    left,
    top,
    cw,
    ch,
    sx: left / pw,
    sy: top / ph,
    sw: cw / pw,
    sh: ch / ph,
    cx: t.x * W,
    cy: t.y * H,
    rotation: t.rotation,
    opacity: Math.min(1, Math.max(0, t.opacity)),
    radius: Math.round(Math.min(0.5, Math.max(0, t.radius)) * Math.min(cw, ch)),
    border: Math.round(Math.max(0, t.borderWidth) * unit),
    borderColor: t.borderColor,
  };
}

/** Upright source size of a media item (rotation metadata is already applied by probing). */
export const mediaPictureSize = (m: Pick<MediaItem, 'width' | 'height'>): { w: number; h: number } => ({ w: Math.max(2, m.width || 1920), h: Math.max(2, m.height || 1080) });

/** Changes transforms (merging into each clip's current one); identity transforms are removed. */
export function updateTransforms(tl: Timeline, clipIds: Id[], patch: Partial<Transform> | ((t: Transform, c: Clip) => Partial<Transform>)): Timeline {
  const updates: Clip[] = [];
  for (const id of clipIds) {
    const c = tl.clips[id];
    if (!c || c.kind !== 'video' || c.text || isTrackLocked(tl, c.trackId)) continue;
    const cur = transformOf(c);
    const p = typeof patch === 'function' ? patch(cur, c) : patch;
    const t: Transform = { ...cur, ...p };
    if ('zoomTo' in p && p.zoomTo === undefined) delete t.zoomTo;
    const next: Clip = { ...c, transform: t };
    if (isIdentityTransform(t)) delete next.transform;
    updates.push(next);
  }
  return updates.length ? setClips(tl, updates) : tl;
}

export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/**
 * Picture-in-picture: the clip shrunk into a corner (a facecam), with an optional border
 * and rounded corners. `size` is the picture's width as a fraction of the frame's.
 */
export function pipTransform(
  corner: Corner,
  media: Pick<MediaItem, 'width' | 'height'>,
  format: FormatPreset,
  opts: { size?: number; border?: boolean; rounded?: boolean } = {},
): Partial<Transform> {
  const { width: W, height: H } = FORMATS[format];
  const { w, h } = mediaPictureSize(media);
  const size = opts.size ?? 0.3;
  const fitScale = Math.min(W / w, H / h);
  const scale = (size * W) / (w * fitScale);
  const pwFrac = (w * fitScale * scale) / W;
  const phFrac = (h * fitScale * scale) / H;
  const margin = 0.04 * Math.min(W, H);
  const mx = margin / W;
  const my = margin / H;
  const right = corner === 'topRight' || corner === 'bottomRight';
  const bottom = corner === 'bottomLeft' || corner === 'bottomRight';
  return {
    fit: 'fit',
    scale,
    x: right ? 1 - mx - pwFrac / 2 : mx + pwFrac / 2,
    y: bottom ? 1 - my - phFrac / 2 : my + phFrac / 2,
    rotation: 0,
    zoomTo: undefined,
    radius: opts.rounded === false ? 0 : 0.12,
    borderWidth: opts.border === false ? 0 : 6,
  };
}

/** Punch-in: a closer framing (110% / 125%), or a smooth zoom to it across the clip. */
export function punchInTransform(amount: number, smooth: boolean): Partial<Transform> {
  return smooth ? { scale: 1, zoomTo: amount } : { scale: amount, zoomTo: undefined };
}

/**
 * Shorts mode: a 9:16 timeline fills the frame with each clip (center crop), and you move
 * the picture sideways to reframe. Going back to 16:9 letterboxes again.
 */
export function reframeForFormat(tl: Timeline, media: Record<Id, MediaItem | undefined>, format: FormatPreset): Timeline {
  const fill = format === 'vertical';
  const ids = Object.values(tl.clips)
    .filter((c) => c.kind === 'video' && !c.text && media[c.mediaId] && transformOf(c).fit !== (fill ? 'fill' : 'fit'))
    .map((c) => c.id);
  return updateTransforms(tl, ids, (t) => (fill ? { fit: 'fill' } : { fit: 'fit', x: 0.5, y: 0.5 }));
}
