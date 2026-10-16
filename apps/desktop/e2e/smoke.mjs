/**
 * End-to-end acceptance test for Phase 1, driving the real app with Playwright.
 *
 *   pnpm --filter @simplecut/desktop e2e
 *
 * Generates test footage, then: imports it, marks In/Out in the source monitor, inserts
 * with `,`, overwrites B-roll (video only) onto V2, drags music onto A2, cuts with the
 * razor, ripple deletes, uses Q and W, undoes/redoes, saves, and exports. The export is
 * checked with ffprobe and compared frame by frame with the source and with the preview.
 * Only native file dialogs are stubbed (in the main process). Screenshots go to e2e-output/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const keep = process.argv.includes('--keep');

// A folder with a space and non-ASCII characters, on purpose.
const work = mkdtempSync(join(tmpdir(), 'simplecut e2e ñ-'));
const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
const talk = join(work, 'talking head.mp4');
const broll = join(work, 'b-roll.mp4');
const music = join(work, 'music bed.mp3');

function step(name) {
  console.log(`\n▶ ${name}`);
}
function check(cond, msg) {
  if (!cond) throw new Error(`Check failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

step('Generating test media');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=30', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', talk]);
ff(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', broll]);
ff(['-f', 'lavfi', '-i', 'sine=f=220:r=44100:d=40', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', music]);

const app = await electron.launch({
  executablePath: electronPath,
  // The app folder (package.json "main" points at the built bundle), like `electron .`.
  args: [appDir],
  cwd: appDir,
  env: { ...process.env, SIMPLECUT_USER_DATA: join(work, 'user-data'), ELECTRON_RENDERER_URL: '' },
});
const errors = [];
const page = await app.firstWindow();
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${decodeURIComponent(r.url())}`));
await page.setViewportSize?.({ width: 1600, height: 960 }).catch(() => {});

const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const press = async (key, times = 1) => {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
};
/** Clip layout per track, read from the DOM: { V1: [[startPx,widthPx],...], ... } */
const clipsOn = (label) =>
  page.$$eval(
    `[data-testid="track-${label}"] ~ .tl-lane [data-testid="clip"]`,
    (els) => els.map((e) => [parseFloat(e.style.left), parseFloat(e.style.width)]).sort((a, b) => a[0] - b[0]),
  );
let px = 1;
/** Clips on a track as [startFrame, endFrame] pairs, e.g. [[0,130],[130,220]]. */
const framesOn = async (label) => (await clipsOn(label)).map(([l, w]) => [Math.round(l / px), Math.round((l + w) / px)]);
const fmt = (x) => JSON.stringify(x);
const programFrame = () => page.$eval('.playhead-line', (e) => Number(e.dataset.frame));
const goToFrame = async (frame) => {
  await page.click('[data-testid="program-tc"]');
  await press('Home');
  await press('Shift+ArrowRight', Math.floor(frame / 5));
  await press('ArrowRight', frame % 5);
};

try {
  await page.waitForSelector('[data-testid="timeline"]');
  await page.waitForTimeout(500);
  await shot('01-empty');

  step('Import via the Import button (native dialog stubbed)');
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, [talk, broll, music]);
  await page.click('.topbar [aria-label="Import media"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="bin-item"]').length === 3, null, { timeout: 30000 });
  check(true, '3 items in the media bin');
  await page.waitForSelector('.bin-thumb img', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot('02-imported');

  step('Source monitor: mark 0–10 s of the talking head and insert with ,');
  await page.dblclick('[data-testid="bin-item"] >> nth=0');
  await page.waitForSelector('[data-testid="source-monitor"] video');
  await page.waitForTimeout(500);
  await press('Home');
  await press('i');
  await press('Shift+ArrowRight', 59);
  await press('ArrowRight', 4);
  await press('o');
  check((await page.textContent('[data-testid="source-tc"]')) === '00:00:09:29', 'source playhead at 00:00:09:29');
  await press(',');
  await page.waitForTimeout(300);
  check((await clipsOn('V1')).length === 1 && (await clipsOn('A1')).length === 1, 'linked video + audio clip on V1/A1');
  px = (await clipsOn('V1'))[0][1] / 300;
  check(Math.abs(px * 300 - (await clipsOn('A1'))[0][1]) < 0.01, 'clip is exactly 300 frames (10 s)');

  step('B-roll: video only (A toggle off), 1–4 s, overwrite onto V2 at 2 s');
  await page.dblclick('[data-testid="bin-item"] >> nth=1');
  await page.waitForTimeout(400);
  await page.click('[data-testid="source-monitor"] .src-toggle.a');
  await press('Home');
  await press('Shift+ArrowRight', 6);
  await press('i');
  await press('Shift+ArrowRight', 17);
  await press('ArrowRight', 4);
  await press('o');
  await goToFrame(60);
  await page.click('[data-testid="track-V2"] .track-target');
  await press('.');
  await page.click('[data-testid="track-V1"] .track-target');
  await page.waitForTimeout(300);
  const v2 = await clipsOn('V2');
  check(v2.length === 1 && Math.round(v2[0][0] / px) === 60 && Math.round(v2[0][1] / px) === 90, 'B-roll on V2 from frame 60 for 90 frames');
  check((await clipsOn('A1')).length === 1 && (await clipsOn('A2')).length === 0, 'no B-roll audio was added');

  step('Music: drag from the bin onto A2');
  const a2row = page.locator('.tl-row.audio').nth(1);
  await page.locator('[data-testid="bin-item"]').nth(2).dragTo(a2row, { targetPosition: { x: 160, y: 25 } });
  await page.waitForTimeout(400);
  const a2 = await clipsOn('A2');
  check(a2.length === 1 && Math.round(a2[0][0] / px) === 0, 'music on A2 starting at 0');
  const musicFrames = (await framesOn('A2'))[0];

  step('Razor at 5 s and 6 s, then ripple delete the middle');
  await press('s'); // snapping off for free-hand razor clicks
  await press('c');
  const v1box = await page.locator('[data-testid="track-V1"] ~ .tl-lane [data-testid="clip"]').first().boundingBox();
  await page.mouse.click(v1box.x + 150 * px + px / 4, v1box.y + v1box.height / 2);
  await page.mouse.click(v1box.x + 180 * px + px / 4, v1box.y + v1box.height / 2);
  check((await clipsOn('V1')).length === 3 && (await clipsOn('A1')).length === 3, 'razor cut V1 and its linked audio into 3 pieces');
  await press('v');
  await page.mouse.click(v1box.x + 165 * px, v1box.y + v1box.height / 2);
  await press('Delete');
  await page.waitForTimeout(200);
  const afterRipple = await framesOn('V1');
  check(fmt(afterRipple) === '[[0,150],[150,270]]', `ripple delete closed the gap: V1 ${fmt(afterRipple)}`);
  check(fmt(await framesOn('A1')) === '[[0,150],[150,270]]', `linked audio followed: A1 ${fmt(await framesOn('A1'))}`);
  check(fmt(await framesOn('A2')) === fmt([musicFrames]), `music bed untouched: A2 ${fmt(await framesOn('A2'))}`);
  await press('s');

  step('W at frame 240, Q at frame 20');
  await goToFrame(240);
  await press('w');
  await goToFrame(20);
  await press('q');
  await page.waitForTimeout(200);
  const v1 = (await clipsOn('V1')).map(([l, w]) => [Math.round(l / px), Math.round((l + w) / px)]);
  check(JSON.stringify(v1) === '[[0,130],[130,220]]', `V1 is ${JSON.stringify(v1)}`);
  const v2b = (await clipsOn('V2')).map(([l, w]) => [Math.round(l / px), Math.round((l + w) / px)]);
  check(JSON.stringify(v2b) === '[[40,130]]', `B-roll followed the edit: ${JSON.stringify(v2b)}`);
  check((await programFrame()) === 0, 'Q moved the playhead to the edit point');

  step('Trim the music to end with the video (razor snaps to the playhead, Shift+Delete)');
  await press('ArrowDown'); // 40
  await press('ArrowDown'); // 130
  await press('ArrowDown'); // 220
  check((await programFrame()) === 220, 'Down arrow jumped to the end of the video');
  await press('c');
  const a2box = await page.locator('[data-testid="track-A2"] ~ .tl-lane [data-testid="clip"]').first().boundingBox();
  await page.mouse.click(a2box.x + 220 * px + 2, a2box.y + a2box.height / 2);
  await press('v');
  await page.mouse.click(a2box.x + 260 * px, a2box.y + a2box.height / 2);
  await press('Shift+Delete');
  await page.waitForTimeout(200);
  const a2final = (await clipsOn('A2')).map(([l, w]) => [Math.round(l / px), Math.round((l + w) / px)]);
  check(JSON.stringify(a2final) === '[[0,220]]', `music now ${JSON.stringify(a2final)}`);

  step('Undo / redo');
  await press('Control+z');
  check((await clipsOn('A2')).length === 2, 'undo brought the music tail back');
  await press('Control+Shift+z');
  check((await clipsOn('A2')).length === 1, 'redo removed it again');
  await page.click('.tabs button:has-text("History")');
  await page.waitForTimeout(200);
  await shot('03-edited-history');
  await page.click('.tabs button:has-text("Properties")');

  step('Save project (dialog stubbed)');
  const projectPath = join(work, 'My Vlog.scut');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, projectPath);
  await press('Control+s');
  await page.waitForTimeout(500);
  check(existsSync(projectPath), 'project file written');
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  check(project.format === 'simplecut-project' && project.version === 1, 'versioned .scut format');
  check(project.media.every((m) => m.path && !m.path.includes('\\')), 'media paths stored relative with forward slashes');

  step('Preview frame for later comparison');
  await goToFrame(140);
  await page.waitForTimeout(800);
  const previewPng = join(work, 'preview-140.png');
  const dataUrl = await page.$eval('[data-testid="program-canvas"]', (c) => c.toDataURL('image/png'));
  writeFileSync(previewPng, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await shot('04-program-frame-140');

  step('Export for YouTube (Ctrl+M)');
  const outPath = join(work, 'My Vlog.mp4');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, outPath);
  await press('Control+m');
  await page.waitForSelector('[data-testid="export-dialog"]');
  await shot('05-export-dialog');
  await page.click('[data-testid="export-start"]');
  await page.waitForSelector('[data-testid="export-progress"]', { timeout: 10000 }).catch(() => {});
  await shot('06-exporting');
  await page.waitForSelector('[data-testid="export-output"]', { timeout: 180000 });
  await shot('07-exported');
  check(existsSync(outPath), 'MP4 written');

  step('Verify the export');
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', '-show_format', outPath]).toString());
  const vs = info.streams.find((s) => s.codec_type === 'video');
  const as = info.streams.find((s) => s.codec_type === 'audio');
  check(vs.codec_name === 'h264' && vs.width === 1920 && vs.height === 1080 && vs.r_frame_rate === '30/1', 'H.264 1920×1080 30 fps');
  check(Number(vs.nb_read_frames) === 220, `exactly 220 frames (got ${vs.nb_read_frames})`);
  check(as.codec_name === 'aac' && as.sample_rate === '48000' && as.channels === 2, 'AAC 48 kHz stereo');

  const gray = (path, n) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `trim=start_frame=${n}:end_frame=${n + 1},scale=480:270`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1 << 26 });
  const grayImage = (path) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', 'scale=480:270', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  const psnr = (a, b) => {
    let se = 0;
    for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2;
    return 10 * Math.log10((255 * 255) / (se / a.length || 1e-9));
  };
  const bestOf = (frame, src, center) => {
    const scores = [-1, 0, 1].map((d) => psnr(frame, gray(src, center + d)));
    return { scores, exact: scores[1] > scores[0] + 3 && scores[1] > scores[2] + 3 && scores[1] > 28 };
  };
  // Timeline 10 → talking head source frame 30; timeline 140 → source 190 (after Q, W and the ripple delete).
  const at10 = bestOf(gray(outPath, 10), talk, 30);
  check(at10.exact, `export frame 10 is source frame 30 (PSNR ${at10.scores.map((s) => s.toFixed(1)).join(' / ')})`);
  const at140 = bestOf(gray(outPath, 140), talk, 190);
  check(at140.exact, `export frame 140 is source frame 190 (PSNR ${at140.scores.map((s) => s.toFixed(1)).join(' / ')})`);
  // The preview is RGB converted by Chromium; compare in RGB, decoding the source with the
  // matrix Chromium used (BT.709 or BT.601 — whichever matches best).
  const rgb = (path, n, matrix) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `trim=start_frame=${n}:end_frame=${n + 1},scale=480:270:in_color_matrix=${matrix}:in_range=tv`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 26 });
  const previewRgb = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', previewPng, '-vf', 'scale=480:270', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const pvScores = ['bt709', 'bt601'].map((m) => [-1, 0, 1].map((d) => psnr(previewRgb, rgb(talk, 190 + d, m))));
  const pv = pvScores.sort((a, b) => b[1] - a[1])[0];
  check(pv[1] > pv[0] + 3 && pv[1] > pv[2] + 3 && pv[1] > 28, `preview frame 140 is source frame 190 too (PSNR ${pv.map((x) => x.toFixed(1)).join(' / ')})`);
  const pvExport = Math.max(psnr(previewRgb, rgb(outPath, 140, 'bt709')), psnr(previewRgb, rgb(outPath, 140, 'bt601')));
  check(pvExport > 28, `preview matches the exported frame (PSNR ${pvExport.toFixed(1)})`);

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nALL CHECKS PASSED');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (errors.length) console.error('Console errors:\n  ' + errors.join('\n  '));
  await shot('zz-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }).catch(() => {});
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  try {
    app.process().kill();
  } catch {}
  if (!keep) rmSync(work, { recursive: true, force: true });
  else console.log(`Kept test folder: ${work}`);
}
