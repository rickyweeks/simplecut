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

// whisper.cpp (auto captions): the official CPU build, pinned and checksum-verified, into
// resources/bin/whisper. The speech model is NOT bundled; the app downloads it on first use.
const WHISPER = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
};
const whisperDir = join(outDir, 'whisper');
if (!existsSync(join(whisperDir, 'whisper-cli.exe'))) {
  const { createHash } = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readdirSync, rmSync, writeFileSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  console.log(`prepare-bin: downloading whisper.cpp engine (${WHISPER.url})`);
  const res = await fetch(WHISPER.url);
  if (!res.ok) throw new Error(`whisper.cpp download failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(zip).digest('hex');
  if (digest !== WHISPER.sha256) throw new Error(`whisper.cpp download has the wrong checksum (${digest})`);
  const tmp = mkdtempSync(join(tmpdir(), 'scut-whisper-'));
  try {
    const zipPath = join(tmp, 'whisper.zip');
    writeFileSync(zipPath, zip);
    const unpacked = join(tmp, 'x');
    mkdirSync(unpacked);
    // Windows 10+ ships bsdtar, which reads zip files.
    execFileSync(join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', unpacked]);
    const find = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isFile() && e.name === 'whisper-cli.exe') return dir;
        if (e.isDirectory()) {
          const r = find(p);
          if (r) return r;
        }
      }
      return null;
    };
    const binDir = find(unpacked);
    if (!binDir) throw new Error('whisper-cli.exe is not in the whisper.cpp download');
    mkdirSync(whisperDir, { recursive: true });
    // Just the CLI and the libraries it loads (the zip also has demos and tests).
    for (const name of readdirSync(binDir)) if (/^(whisper-cli\.exe|whisper\.dll|ggml.*\.dll)$/i.test(name)) cpSync(join(binDir, name), join(whisperDir, name));
    console.log(`prepare-bin: whisper.cpp -> ${whisperDir}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
