import { FORMATS, hasZoom, isIdentityTransform, mediaPictureSize, pictureGeometry, transformOf, type Clip, type MediaItem, type PictureGeometry, type Timeline } from '@simplecut/core';

/**
 * Transformed pictures. The preview draws them here; for export the same rounded rectangle
 * and border are drawn into images at the picture's size (the export can't draw them itself),
 * so corners and borders look identical in both.
 */

/** The visible part of the picture, relative to the picture's center (output pixels). */
export function visibleRect(g: PictureGeometry): { x: number; y: number; w: number; h: number } {
  return { x: -g.pw / 2 + g.left, y: -g.ph / 2 + g.top, w: g.cw, h: g.ch };
}

function roundRectPath(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (r > 0) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

/** A border just inside the visible rectangle (its outer edge follows the rounded corners). */
function strokeBorder(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, width: number, color: string): void {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.lineWidth = width * 2;
  ctx.strokeStyle = color;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws a picture with its transform onto the program canvas. `k` is canvas pixels per
 * output pixel (the playback resolution), `dx` a horizontal shift as a fraction of the
 * frame (slide transitions), `alpha` the transition alpha.
 */
export function drawTransformed(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  g: PictureGeometry,
  k: number,
  frameW: number,
  dx: number,
  alpha: number,
): void {
  const a = alpha * g.opacity;
  if (a <= 0) return;
  const v = visibleRect(g);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate((g.cx + dx * frameW) * k, g.cy * k);
  if (g.rotation) ctx.rotate((g.rotation * Math.PI) / 180);
  ctx.scale(k, k);
  if (g.radius > 0) {
    roundRectPath(ctx, v.x, v.y, v.w, v.h, g.radius);
    ctx.clip();
  }
  ctx.drawImage(src, g.sx * srcW, g.sy * srcH, g.sw * srcW, g.sh * srcH, v.x, v.y, v.w, v.h);
  if (g.border > 0) strokeBorder(ctx, v.x, v.y, v.w, v.h, g.radius, g.border, g.borderColor);
  ctx.restore();
}

async function pngBytes(c: OffscreenCanvas): Promise<Uint8Array> {
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/** Export images for a clip's rounded corners (alpha mask) and border, at the picture's size. */
export async function pictureImages(g: PictureGeometry): Promise<{ mask?: Uint8Array; ring?: Uint8Array }> {
  const out: { mask?: Uint8Array; ring?: Uint8Array } = {};
  const v = { x: g.left, y: g.top, w: g.cw, h: g.ch };
  if (g.radius > 0) {
    const c = new OffscreenCanvas(g.pw, g.ph);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    roundRectPath(ctx, v.x, v.y, v.w, v.h, g.radius);
    ctx.fill();
    out.mask = await pngBytes(c);
  }
  if (g.border > 0) {
    const c = new OffscreenCanvas(g.pw, g.ph);
    strokeBorder(c.getContext('2d')!, v.x, v.y, v.w, v.h, g.radius, g.border, g.borderColor);
    out.ring = await pngBytes(c);
  }
  return out;
}

/**
 * Masks and borders for every transformed clip in a range, for the export request. Uses the
 * same geometry as the export graph (a smooth zoom renders at its smaller scale).
 */
export async function clipImagesFor(
  tl: Timeline,
  media: Record<string, MediaItem | undefined>,
  range: { start: number; end: number },
  size: { width: number; height: number } = FORMATS[tl.settings.format],
): Promise<Record<string, { mask?: Uint8Array; ring?: Uint8Array }>> {
  const out: Record<string, { mask?: Uint8Array; ring?: Uint8Array }> = {};
  for (const c of Object.values(tl.clips) as Clip[]) {
    if (c.kind !== 'video' || c.text || isIdentityTransform(c.transform) || c.start >= range.end || c.start + c.duration <= range.start) continue;
    const m = media[c.mediaId];
    if (!m) continue;
    const t = transformOf(c);
    if (!t.radius && !t.borderWidth) continue;
    const { w, h } = mediaPictureSize(m);
    const base = hasZoom(t) ? Math.min(t.scale, t.zoomTo!) : t.scale;
    out[c.id] = await pictureImages(pictureGeometry(t, w, h, size.width, size.height, base));
  }
  return out;
}
