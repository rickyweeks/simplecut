import type { TextContent } from '@simplecut/core';

/**
 * Draws a title into a transparent canvas the size of the video frame. The preview
 * composites this canvas and the export receives it as a PNG, so titles look identical in
 * both. Sizes in TextStyle are pixels at 1080p and scale with the frame's shorter side.
 */
export interface RenderedText {
  canvas: HTMLCanvasElement;
  /** The text block (including its box) in frame pixels, for hit-testing and dragging. */
  bounds: { x: number; y: number; w: number; h: number };
}

const cache = new Map<string, RenderedText>();
const MAX_CACHE = 40;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function renderText(text: TextContent, W: number, H: number): RenderedText {
  const key = `${W}x${H}|${JSON.stringify(text)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const s = Math.min(W, H) / 1080;
  const size = text.size * s;
  ctx.font = `${text.italic ? 'italic ' : ''}${text.bold ? 700 : 400} ${size}px "${text.font}", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  const lines = text.content.split('\n');
  const lineHeight = size * 1.22;
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  const blockW = Math.max(1, ...widths);
  const blockH = lines.length * lineHeight;
  const cx = text.x * W;
  const cy = text.y * H;
  const left = cx - blockW / 2;
  const top = cy - blockH / 2;
  const pad = text.box ? text.boxPadding * s : 0;
  const bounds = { x: left - pad, y: top - pad, w: blockW + 2 * pad, h: blockH + 2 * pad };

  if (text.box && text.boxOpacity > 0) {
    ctx.fillStyle = hexToRgba(text.boxColor, text.boxOpacity);
    roundRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, text.boxRadius * s);
    ctx.fill();
  }

  lines.forEach((line, i) => {
    const w = widths[i]!;
    const x = text.align === 'left' ? left : text.align === 'right' ? left + blockW - w : cx - w / 2;
    const y = top + lineHeight * i + lineHeight / 2;
    if (text.shadow) {
      ctx.shadowColor = hexToRgba(text.shadowColor, 0.85);
      ctx.shadowBlur = text.shadowBlur * s;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = text.shadowDistance * s;
    }
    if (text.outlineWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = text.outlineWidth * s * 2;
      ctx.strokeStyle = text.outlineColor;
      ctx.strokeText(line, x, y);
      // Only the outline casts the shadow; the fill sits on top of it.
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = text.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
  });

  const result = { canvas, bounds };
  cache.set(key, result);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return result;
}

/** PNG bytes of a title, for the export. */
export function textPng(text: TextContent, W: number, H: number): Promise<Uint8Array> {
  const { canvas } = renderText(text, W, H);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not render a title.'));
      void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, 'image/png'),
  );
}
