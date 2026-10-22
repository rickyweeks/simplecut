/**
 * Additional end-to-end checks (run after `electron-vite build`):
 *   node e2e/extras.mjs
 *
 * 1. Variable-frame-rate footage is detected and conformed by a background proxy, and the
 *    preview switches to it.
 * 2. Real-time playback advances the playhead at the right speed.
 * 3. A 30-minute project with ~200 clips per track stays smooth while dragging.
 * 4. Crash recovery: an autosave survives a hard kill and is offered back on next launch.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const shots = join(appDir, 'e2e-output');
mkdirSync(shots, { recursive: true });
const ffmpeg = join(appDir, 'resources', 'bin', 'ffmpeg.exe');
const ffprobe = join(appDir, 'resources', 'bin', 'ffprobe.exe');
const work = mkdtempSync(join(tmpdir(), 'simplecut-extras-'));
const userData = join(work, 'user-data');
const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
const step = (n) => console.log(`\n▶ ${n}`);
function check(cond, msg) {
  if (!cond) throw new Error(`Check failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const launch = () =>
  electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...process.env, SIMPLECUT_USER_DATA: userData, ELECTRON_RENDERER_URL: '' } });

step('Generating media');
// VFR: drop 2 of every 10 frames but keep the original timestamps (phone-like jitter).
const vfr = join(work, 'phone vfr.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-vf', "select='lt(mod(n,10),8)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vfr]);
const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', vfr]).toString()).streams[0];
console.log(`  (VFR test file: r_frame_rate ${probe.r_frame_rate}, avg_frame_rate ${probe.avg_frame_rate})`);
// A 30-minute low-res source for the large-project test.
const long = join(work, 'long.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1800', '-f', 'lavfi', '-i', 'anoisesrc=d=1800:a=0.1:r=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', long]);

let app = await launch();
let page = await app.firstWindow();
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
};
watch(page);
const press = async (key, n = 1) => {
  for (let i = 0; i < n; i++) await page.keyboard.press(key);
};

try {
  await page.waitForSelector('[data-testid="timeline"]');
  // First launch shows the tutorial; these tests drive the editor directly.
  await page.click('[data-testid="tutorial-skip"]', { timeout: 5000 }).catch(() => {});

  step('VFR footage gets a constant-frame-rate proxy automatically');
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, vfr);
  await page.click('.topbar [aria-label="Import media"]');
  await page.waitForSelector('[data-testid="bin-item"]');
  const sawOptimizing = await page
    .waitForSelector('.bin-status', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check(sawOptimizing, 'bin shows "Optimizing for editing" for the VFR clip');
  await page.screenshot({ path: join(shots, '10-vfr-optimizing.png') });
  await page.waitForSelector('.bin-status', { state: 'detached', timeout: 120000 });
  check(true, 'proxy finished');
  await page.dblclick('[data-testid="bin-item"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="source-monitor"] video')?.src.includes('proxy'), null, { timeout: 10000 });
  check(true, 'source monitor plays the proxy');

  step('Real-time playback');
  await press(',');
  await page.click('[data-testid="program-tc"]');
  await press('Home');
  const before = await page.$eval('.playhead-line', (e) => Number(e.dataset.frame));
  await press(' ');
  await page.waitForTimeout(1500);
  await press(' ');
  const after = await page.$eval('.playhead-line', (e) => Number(e.dataset.frame));
  check(after - before >= 35 && after - before <= 55, `playhead advanced ${after - before} frames in ~1.5 s at 30 fps`);
  const lit = await page.$eval('[data-testid="program-canvas"]', (c) => {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4 * 97) sum += d[i] + d[i + 1] + d[i + 2];
    return sum;
  });
  check(lit > 0, 'program monitor shows the picture');

  step('Large project: 30 minutes, 200 clips per track');
  const probeLong = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', long]).toString());
  const fmt = probeLong.format;
  const tracks = ['v1', 'v2', 'v3', 'a1', 'a2', 'a3'].map((id) => ({ id, kind: id[0] === 'v' ? 'video' : 'audio', locked: false, muted: false, solo: false, hidden: false }));
  const clips = {};
  for (let i = 0; i < 200; i++) {
    const start = i * 270;
    clips[`v${i}`] = { id: `v${i}`, trackId: 'v1', mediaId: 'long', kind: 'video', start, duration: 270, sourceIn: (i * 997) % 50000, linkId: `L${i}` };
    clips[`a${i}`] = { id: `a${i}`, trackId: 'a1', mediaId: 'long', kind: 'audio', start, duration: 270, sourceIn: (i * 997) % 50000, linkId: `L${i}` };
    if (i % 10 === 3) clips[`b${i}`] = { id: `b${i}`, trackId: 'v2', mediaId: 'long', kind: 'video', start: start + 60, duration: 120, sourceIn: 1000 };
  }
  const project = {
    format: 'simplecut-project',
    version: 1,
    app: 'test',
    savedAt: new Date().toISOString(),
    project: { id: 'perf', name: 'Perf' },
    media: [
      {
        id: 'long', name: 'long.mp4', path: 'long.mp4', absolutePath: long.replace(/\\/g, '/'), kind: 'video', durationSec: Number(fmt.duration), hasVideo: true, hasAudio: true,
        width: 320, height: 180, fps: 30, avgFps: 30, isVFR: false, videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', bitRate: Number(fmt.bit_rate), audioChannels: 1, audioSampleRate: 48000, rotation: 0, fileSize: Number(fmt.size),
      },
    ],
    timeline: { settings: { format: '1080p', fps: 30, sampleRate: 48000, locked: true }, tracks, clips, markers: [], inPoint: null, outPoint: null, targetVideoTrackId: 'v1', targetAudioTrackId: 'a1' },
  };
  const perfPath = join(work, 'perf.scut');
  writeFileSync(perfPath, JSON.stringify(project));
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, perfPath);
  await press('Control+o');
  await page.waitForFunction(() => document.querySelector('.project-name span')?.textContent === 'Perf', null, { timeout: 15000 });
  await page.click('[data-testid="program-tc"]');
  await press('\\');
  await page.waitForTimeout(500);
  const rendered = await page.$$eval('[data-testid="clip"]', (e) => e.length);
  check(rendered >= 400, `${rendered} clips rendered after zoom to fit`);

  // Record frame times while dragging a clip across the whole timeline.
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__rec = true;
    const loop = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__rec) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const box = await page.locator('[data-testid="track-V1"] ~ .tl-lane [data-testid="clip"]').nth(20).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 20, { steps: 40 });
  await page.mouse.move(box.x + 50, box.y - 40, { steps: 40 });
  await page.mouse.up();
  const frames = await page.evaluate(() => {
    window.__rec = false;
    return window.__frames.slice(2);
  });
  frames.sort((a, b) => a - b);
  const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
  const max = frames[frames.length - 1] ?? 0;
  check(p95 < 50, `dragging stays smooth: p95 frame ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms over ${frames.length} frames`);
  await page.screenshot({ path: join(shots, '11-large-project.png') });
  const t0 = Date.now();
  await press('Control+z');
  await page.waitForTimeout(50);
  check(Date.now() - t0 < 1000, 'undo on the large project is instant');

  step('Crash recovery');
  // Same call the 60-second autosave makes, then a hard kill (no clean shutdown).
  const recoveryText = JSON.stringify({ ...project, project: { id: 'crash-test', name: 'Crashed Project' } });
  await page.evaluate((t) => window.scut.recovery.write('crash-test', t, { name: 'Crashed Project', projectPath: null }), recoveryText);
  // Kill the whole process tree (main, GPU, renderer…) like a real crash would.
  try {
    execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  app = await launch();
  page = await app.firstWindow();
  watch(page);
  await page.waitForSelector('[data-testid="recovery-dialog"]', { timeout: 15000 });
  check(true, 'recovery dialog offered on next launch');
  await page.screenshot({ path: join(shots, '12-recovery.png') });
  await page.click('[data-testid="recovery-dialog"] .btn.primary');
  await page.waitForFunction(() => document.querySelector('.project-name span')?.textContent === 'Crashed Project', null, { timeout: 15000 });
  check(await page.$('.dirty-dot'), 'recovered project is marked unsaved');
  check((await page.$$eval('[data-testid="clip"]', (e) => e.length)) > 0, 'recovered clips are on the timeline');

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nALL EXTRA CHECKS PASSED');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  await page.screenshot({ path: join(shots, 'zz-extras-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }).catch(() => {});
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  try {
    app.process().kill();
  } catch {}
  rmSync(work, { recursive: true, force: true });
}
