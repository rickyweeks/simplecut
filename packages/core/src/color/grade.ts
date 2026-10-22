import type { ColorGrade, LookId } from '../types';

/**
 * Color correction.
 *
 * Every setting (an imported LUT, exposure, white balance, contrast, saturation and a look)
 * is folded into ONE 3D lookup table. The preview applies it on the GPU (a 3D texture with
 * trilinear filtering) and the export with FFmpeg's lut3d (trilinear) from a .cube file of
 * the very same numbers, so graded footage looks the same in both.
 *
 * Order (like Premiere's Lumetri): input LUT -> exposure and white balance (in linear light)
 * -> contrast -> saturation -> creative look.
 */

export const DEFAULT_GRADE: ColorGrade = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, look: 'none', lookAmount: 1 };

export const LUT_SIZE = 33;

export const LOOKS: { id: LookId; name: string; description: string }[] = [
  { id: 'none', name: 'None', description: 'No look' },
  { id: 'warm', name: 'Warm', description: 'Golden and sunny' },
  { id: 'cool', name: 'Cool', description: 'Crisp and blue' },
  { id: 'punchy', name: 'Punchy', description: 'More contrast and color' },
  { id: 'film', name: 'Film', description: 'Soft blacks, gentle highlights' },
  { id: 'tealOrange', name: 'Teal & Orange', description: 'The blockbuster look' },
  { id: 'vintage', name: 'Vintage', description: 'Faded and warm' },
  { id: 'moody', name: 'Moody', description: 'Dark and muted' },
  { id: 'bw', name: 'Black & White', description: 'Classic monochrome' },
];

export function isNeutralGrade(g: ColorGrade | undefined): boolean {
  if (!g) return true;
  return !g.exposure && !g.contrast && !g.saturation && !g.temperature && !g.tint && (g.look === 'none' || g.lookAmount <= 0) && !g.lut;
}

/** A parsed .cube file. `data` is RGB triples with red changing fastest, like the file. */
export interface CubeLut {
  title: string;
  /** 3D size, or the 1D length for 1D LUTs. */
  size: number;
  kind: '3d' | '1d';
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: Float32Array;
}

export class CubeParseError extends Error {}

/** Reads an Adobe/Resolve .cube LUT (3D or 1D). */
export function parseCube(text: string): CubeLut {
  let title = '';
  let size = 0;
  let kind: '3d' | '1d' = '3d';
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (key === 'LUT_3D_SIZE') {
      size = Number(parts[1]);
      kind = '3d';
    } else if (key === 'LUT_1D_SIZE') {
      size = Number(parts[1]);
      kind = '1d';
    } else if (key === 'DOMAIN_MIN') domainMin = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    else if (key === 'DOMAIN_MAX') domainMax = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    else if (/^[-+.\deE]/.test(key) && parts.length >= 3) values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!Number.isInteger(size) || size < 2 || size > 256) throw new CubeParseError('This .cube file has no valid LUT size.');
  const expected = kind === '3d' ? size * size * size * 3 : size * 3;
  if (values.length !== expected || values.some((v) => !Number.isFinite(v))) {
    throw new CubeParseError(`This .cube file should have ${expected / 3} color rows but has ${values.length / 3}.`);
  }
  return { title, size, kind, domainMin, domainMax, data: Float32Array.from(values) };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Looks a color up in a LUT (trilinear for 3D, linear per channel for 1D). */
export function sampleCube(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const norm = (v: number, i: 0 | 1 | 2) => clamp01((v - lut.domainMin[i]) / (lut.domainMax[i] - lut.domainMin[i] || 1)) * (n - 1);
  const d = lut.data;
  if (lut.kind === '1d') {
    const ch = (v: number, i: 0 | 1 | 2) => {
      const x = norm(v, i);
      const i0 = Math.min(n - 2, Math.floor(x));
      const f = x - i0;
      return d[i0 * 3 + i]! * (1 - f) + d[(i0 + 1) * 3 + i]! * f;
    };
    return [ch(r, 0), ch(g, 1), ch(b, 2)];
  }
  const x = norm(r, 0);
  const y = norm(g, 1);
  const z = norm(b, 2);
  const x0 = Math.min(n - 2, Math.floor(x));
  const y0 = Math.min(n - 2, Math.floor(y));
  const z0 = Math.min(n - 2, Math.floor(z));
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (i: number, j: number, k: number) => d[((k * n + j) * n + i) * 3 + c]!;
    const c00 = at(x0, y0, z0) * (1 - fx) + at(x0 + 1, y0, z0) * fx;
    const c10 = at(x0, y0 + 1, z0) * (1 - fx) + at(x0 + 1, y0 + 1, z0) * fx;
    const c01 = at(x0, y0, z0 + 1) * (1 - fx) + at(x0 + 1, y0, z0 + 1) * fx;
    const c11 = at(x0, y0 + 1, z0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1, z0 + 1) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}

const GAMMA = 2.2;
const toLinear = (v: number) => Math.pow(Math.max(0, v), GAMMA);
const toGamma = (v: number) => Math.pow(Math.max(0, v), 1 / GAMMA);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** White-balance channel gains for temperature / tint (-100..100), luminance-neutral. */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100;
  const m = tint / 100;
  const r = Math.pow(2, 0.35 * t);
  const g = Math.pow(2, -0.3 * m);
  const b = Math.pow(2, -0.35 * t);
  const y = luma(r, g, b);
  return [r / y, g / y, b / y];
}

/** Smooth S-curve around mid-gray that never clips: k > 1 adds contrast, k < 1 flattens. */
function sCurve(v: number, k: number): number {
  const x = clamp01(v);
  return x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k);
}

function saturate(r: number, g: number, b: number, s: number): [number, number, number] {
  const y = luma(r, g, b);
  return [y + (r - y) * s, y + (g - y) * s, y + (b - y) * s];
}

type RGB = [number, number, number];

function applyLook(look: LookId, [r, g, b]: RGB): RGB {
  switch (look) {
    case 'warm':
      return saturate(r * 1.06, g * 1.01, b * 0.9, 1.05);
    case 'cool':
      return saturate(r * 0.93, g * 0.99, b * 1.08, 1.0);
    case 'punchy': {
      const k = 1.35;
      return saturate(sCurve(r, k), sCurve(g, k), sCurve(b, k), 1.28);
    }
    case 'film': {
      const lift = (v: number) => 0.055 + sCurve(v, 1.12) * 0.91;
      const [r2, g2, b2] = saturate(lift(r), lift(g), lift(b), 0.88);
      const y = luma(r2, g2, b2);
      return [r2 + 0.02 * (1 - y), g2 + 0.005, b2 - 0.015 * (1 - y)];
    }
    case 'tealOrange': {
      const k = 1.15;
      const [r1, g1, b1] = [sCurve(r, k), sCurve(g, k), sCurve(b, k)];
      const y = luma(r1, g1, b1);
      const sh = (1 - y) * (1 - y);
      const hi = y * y;
      return saturate(r1 - 0.06 * sh + 0.07 * hi, g1 + 0.02 * sh + 0.015 * hi, b1 + 0.07 * sh - 0.07 * hi, 1.1);
    }
    case 'vintage': {
      const fade = (v: number) => 0.08 + v * 0.84;
      return saturate(fade(r) * 1.05, fade(g), fade(b) * 0.88, 0.78);
    }
    case 'moody': {
      const k = 1.2;
      const [r1, g1, b1] = saturate(sCurve(r * 0.9, k), sCurve(g * 0.9, k), sCurve(b * 0.9, k), 0.72);
      const y = luma(r1, g1, b1);
      return [r1 - 0.01 * (1 - y), g1, b1 + 0.03 * (1 - y)];
    }
    case 'bw': {
      const y = sCurve(luma(r, g, b), 1.15);
      return [y, y, y];
    }
    default:
      return [r, g, b];
  }
}

/** The whole grade as a color function on gamma-encoded RGB in 0..1. */
export function gradeFunction(g: ColorGrade, input?: CubeLut | null): (r: number, gg: number, b: number) => RGB {
  const ev = Math.pow(2, Math.max(-4, Math.min(4, g.exposure)));
  const [wr, wg, wb] = whiteBalanceGains(g.temperature, g.tint);
  const k = Math.pow(2, (Math.max(-100, Math.min(100, g.contrast)) / 100) * 1.4);
  const sat = Math.max(0, 1 + Math.max(-100, Math.min(100, g.saturation)) / 100);
  const lookAmount = g.look === 'none' ? 0 : Math.min(1, Math.max(0, g.lookAmount));
  return (r0, g0, b0) => {
    let r = r0;
    let gg = g0;
    let b = b0;
    if (input) [r, gg, b] = sampleCube(input, r, gg, b);
    r = toGamma(toLinear(r) * ev * wr);
    gg = toGamma(toLinear(gg) * ev * wg);
    b = toGamma(toLinear(b) * ev * wb);
    if (k !== 1) {
      r = sCurve(r, k);
      gg = sCurve(gg, k);
      b = sCurve(b, k);
    }
    if (sat !== 1) [r, gg, b] = saturate(r, gg, b, sat);
    if (lookAmount > 0) {
      const [lr, lg, lb] = applyLook(g.look, [clamp01(r), clamp01(gg), clamp01(b)]);
      r += (lr - r) * lookAmount;
      gg += (lg - gg) * lookAmount;
      b += (lb - b) * lookAmount;
    }
    return [clamp01(r), clamp01(gg), clamp01(b)];
  };
}

/** Bakes a grade into a size^3 RGB table (red fastest, the .cube order). */
export function bakeLut(g: ColorGrade, input?: CubeLut | null, size = LUT_SIZE): Float32Array {
  const f = gradeFunction(g, input);
  const out = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, gg, b] = f(ri / (size - 1), gi / (size - 1), bi / (size - 1));
        out[o++] = r;
        out[o++] = gg;
        out[o++] = b;
      }
    }
  }
  return out;
}

/** A baked table as a .cube file for FFmpeg's lut3d. */
export function cubeText(lut: Float32Array, size = LUT_SIZE): string {
  const lines = ['TITLE "SimpleCut grade"', `LUT_3D_SIZE ${size}`];
  for (let i = 0; i < lut.length; i += 3) lines.push(`${lut[i]!.toFixed(6)} ${lut[i + 1]!.toFixed(6)} ${lut[i + 2]!.toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** Stable key for caching a grade's table (the input LUT is identified by its path). */
export const gradeKey = (g: ColorGrade): string =>
  [g.exposure, g.contrast, g.saturation, g.temperature, g.tint, g.look, g.lookAmount, g.lut?.path ?? ''].join('|');

/**
 * Auto Color: white balance (gray world over the mid-tones), exposure (median toward
 * mid-gray) and contrast (stretch a flat image), from sampled pixels (RGB bytes).
 * Deliberately gentle: it gets most footage close and never wrecks a shot.
 */
export function autoColor(rgb: Uint8Array): Pick<ColorGrade, 'exposure' | 'contrast' | 'temperature' | 'tint'> {
  const n = Math.floor(rgb.length / 3);
  if (n < 16) return { exposure: 0, contrast: 0, temperature: 0, tint: 0 };
  const ys = new Float32Array(n);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3]! / 255;
    const g = rgb[i * 3 + 1]! / 255;
    const b = rgb[i * 3 + 2]! / 255;
    const y = luma(r, g, b);
    ys[i] = y;
    if (y > 0.12 && y < 0.88) {
      sr += toLinear(r);
      sg += toLinear(g);
      sb += toLinear(b);
      count++;
    }
  }
  ys.sort();
  const pct = (p: number) => ys[Math.min(n - 1, Math.floor(p * n))]!;
  const p01 = pct(0.01);
  const p50 = pct(0.5);
  const p99 = pct(0.99);
  let temperature = 0;
  let tint = 0;
  if (count > n * 0.05 && sr > 0 && sg > 0 && sb > 0) {
    temperature = (Math.log2(sb / sr) / 0.7) * 100 * 0.75;
    tint = (-Math.log2(Math.sqrt(sr * sb) / sg) / 0.3) * 100 * 0.75;
  }
  const exposure = p50 > 0.01 ? Math.log2(toLinear(0.45) / toLinear(p50)) * 0.6 : 0;
  const spread = p99 - p01;
  const contrast = spread < 0.8 ? (0.85 - spread) * 120 : 0;
  const r1 = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));
  return {
    exposure: Math.round(Math.min(1.5, Math.max(-1.5, exposure)) * 100) / 100,
    contrast: r1(contrast, 0, 40),
    temperature: r1(temperature, -60, 60),
    tint: r1(tint, -40, 40),
  };
}
