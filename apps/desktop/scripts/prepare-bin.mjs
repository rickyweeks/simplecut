// Copies the FFmpeg and ffprobe executables from ffmpeg-static / ffprobe-static into
// resources/bin. The app runs them from there in development, and electron-builder ships
// that folder as extraResources (outside the asar archive) in the installer.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'resources', 'bin');

const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

if (!ffmpeg || !existsSync(ffmpeg)) {
  console.error(
    'ffmpeg-static has no binary. Its install script may not have run; try:\n' +
      '  node node_modules/ffmpeg-static/install.js\n(from the repository root)',
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const [src, name] of [
  [ffmpeg, 'ffmpeg.exe'],
  [ffprobe, 'ffprobe.exe'],
]) {
  const dest = join(outDir, name);
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue;
  copyFileSync(src, dest);
  console.log(`prepare-bin: ${name} <- ${src}`);
}
