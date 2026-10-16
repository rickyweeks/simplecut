// Renders the app icon (build/icon.png, 512×512) with no dependencies: a blue rounded square
// with a white "play" triangle cut by a diagonal — SimpleCut's mark. electron-builder turns
// it into the Windows .ico. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SS = 4; // supersampling for smooth edges

function inRoundedSquare(x, y) {
  const m = 24;
  const r = 110;
  const lo = m + r;
  const hi = SIZE - m - r;
  const cx = Math.min(Math.max(x, lo), hi);
  const cy = Math.min(Math.max(y, lo), hi);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && x <= SIZE - m && y >= m && y <= SIZE - m;
}

function inTriangle(x, y) {
  // Play triangle, slightly right of center.
  const ax = 190, ay = 140, bx = 190, by = 372, cx = 382, cy = 256;
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function inCut(x, y) {
  // A diagonal gap through the triangle: the "cut".
  const d = (x - y * 0.55 - 150) / Math.hypot(1, 0.55);
  return Math.abs(d) < 11;
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!inRoundedSquare(px, py)) continue;
        a += 255;
        if (inTriangle(px, py) && !inCut(px, py)) {
          r += 255; g += 255; b += 255;
        } else {
          // Vertical gradient from #5b95ff to #2f6cf0.
          const t = py / SIZE;
          r += 91 + (47 - 91) * t;
          g += 149 + (108 - 149) * t;
          b += 255 + (240 - 255) * t;
        }
      }
    }
    const n = SS * SS;
    const cover = a / n / 255;
    const o = 1 + x * 4;
    row[o] = cover ? Math.round(r / n / cover) : 0;
    row[o + 1] = cover ? Math.round(g / n / cover) : 0;
    row[o + 2] = cover ? Math.round(b / n / cover) : 0;
    row[o + 3] = Math.round(a / n);
  }
  rows.push(row);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
