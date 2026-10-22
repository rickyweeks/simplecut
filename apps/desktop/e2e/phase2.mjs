/**
 * Phase 2 end-to-end test (run after `electron-vite build`):  node e2e/phase2.mjs
 *
 * Transitions (Ctrl+D), Add music + beat detection, jumping to beats, titles from the
 * Titles tab, the clip volume line, noise reduction, loudness normalization and an export
 * that contains all of it — through the real UI. Screenshots go to e2e-output/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
const work = mkdtempSync(join(tmpdir(), 'simplecut-p2-'));
const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
const step = (n) => console.log(`\n▶ ${n}`);
function check(cond, msg) {
  if (!cond) throw new Error(`Check failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

step('Generating media');
const talk = join(work, 'talk.mp4');
const song = join(work, 'song 120bpm.wav');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=12', '-f', 'lavfi', '-i', "anoisesrc=d=12:c=pink:a=0.25,volume='0.2+0.8*gt(sin(2*PI*2.7*t),0)':eval=frame", '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
// A 120 BPM "song": a kick on every beat from 0.2 s, plus a quiet pad so it's never silent.
const kick = 'mod(t-0.2,0.5)';
ff(['-f', 'lavfi', '-i', `aevalsrc='gte(t,0.2)*0.8*sin(2*PI*(50+90*exp(-30*${kick}))*${kick})*exp(-9*${kick})+0.05*sin(2*PI*220*t)+0.03*sin(2*PI*330*t)':s=44100:d=20`, song]);

const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...process.env, SIMPLECUT_USER_DATA: join(work, 'user-data'), ELECTRON_RENDERER_URL: '' } });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const press = async (key, n = 1) => {
  for (let i = 0; i < n; i++) await page.keyboard.press(key);
};
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const playhead = () => page.$eval('.playhead-line', (e) => Number(e.dataset.frame));

try {
  await page.waitForSelector('[data-testid="timeline"]');

  step('Two talking-head clips with a cut, then Ctrl+D');
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, talk);
  await page.click('.topbar [aria-label="Import media"]');
  await page.waitForSelector('[data-testid="bin-item"]');
  await page.dblclick('[data-testid="bin-item"]');
  await page.waitForSelector('[data-testid="source-monitor"] video');
  await page.waitForTimeout(400);
  await press('Home');
  await press('i');
  await press('Shift+ArrowRight', 17);
  await press('ArrowRight', 4);
  await press('o');
  await press(','); // 0–3 s
  await press('Shift+ArrowRight', 12);
  await press('i');
  await press('Shift+ArrowRight', 17);
  await press('ArrowRight', 4);
  await press('o');
  await press(','); // another 3 s right after
  await page.click('[data-testid="program-tc"]');
  await press('ArrowUp'); // back to the cut at frame 90
  check((await playhead()) === 90, 'playhead on the cut');
  await press('Control+d');
  await page.waitForSelector('.transition-box', { timeout: 5000 });
  check(true, 'cross dissolve added at the cut');

  step('Add music: beats are detected, shown and snappable');
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, song);
  await page.click('[data-testid="topbar-add-music"]');
  await page.waitForSelector('.beat-tick', { timeout: 30000 });
  const ticks = await page.$$eval('.beat-tick', (e) => e.length);
  check(ticks >= 20, `beat ticks drawn on the music clip (${ticks})`);
  await page.waitForFunction(() => document.body.innerText.includes('120 BPM'), null, { timeout: 5000 });
  check(true, 'Inspector shows 120 BPM');
  const musicTrackOn = await page.$eval('[data-testid="track-A2"] .track-flag.music', (e) => e.classList.contains('on'));
  check(musicTrackOn, 'A2 became the music track');
  await page.click('[data-testid="program-tc"]');
  await press('Home');
  await press('Shift+ArrowDown');
  check((await playhead()) === 6, `Shift+↓ jumps to the first beat (frame ${await playhead()}, expected 6 = 0.2 s)`);
  await press('Shift+ArrowDown');
  check((await playhead()) === 21, `…and the next one (frame ${await playhead()}, expected 21 = 0.7 s)`);
  await shot('20-music-beats');
  await press('Control+z');
  await page.waitForTimeout(600);
  check((await page.$$('.beat-tick')).length === 0,'Ctrl+Z undoes Add music (and beat detection does not sneak back in)');
  await press('Control+Shift+z');
  await page.waitForSelector('.beat-tick', { timeout: 2000 });
  check(true, 'Ctrl+Shift+Z redoes it, beats included');

  step('A title from the Titles tab');
  await page.click('[data-testid="tab-titles"]');
  // In a smaller window the presets fall into one column: they must scroll, not get squashed.
  const size = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const s = w.getSize();
    w.setSize(1465, 956);
    return s;
  });
  await page.waitForTimeout(400);
  // Each tile must be tall enough for its whole picture and its name (tiles clip what doesn't fit).
  const tiles = await page.$$eval('[data-testid="title-preset"]', (items) =>
    items.map((i) => {
      const h = (sel) => i.querySelector(sel).getBoundingClientRect().height;
      return Math.round(i.getBoundingClientRect().height - h('.bin-thumb') - h('.bin-name'));
    }),
  );
  check(tiles.length === 8 && tiles.every((spare) => spare >= 0), `all 8 title previews show their whole picture and name in a narrow panel (${tiles.join(', ')} px spare)`);
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size);
  await page.waitForTimeout(400);
  await page.click('[data-testid="program-tc"]');
  await press('Home');
  await press('Shift+ArrowRight', 6);
  await page.dblclick('[data-testid="title-preset"] >> nth=0');
  await page.waitForSelector('[data-testid="title-text"]');
  await page.fill('[data-testid="title-text"]', 'HELLO WORLD');
  await page.waitForTimeout(900);
  const titleClip = await page.$eval('.clip.text .clip-head span', (e) => e.textContent);
  check(titleClip === 'HELLO WORLD', 'title clip on the timeline shows the typed text');
  await shot('21-title');
  // Bright pixels in the middle band of the Program monitor picture (the white title).
  const brightInPreview = async (name) => {
    const png = join(work, `${name}.png`);
    await page.locator('[data-testid="program-canvas"]').screenshot({ path: png });
    const g = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
    return [...g.slice(80 * 320, 100 * 320)].filter((v) => v > 230).length;
  };
  await page.click('[data-testid="program-tc"]');
  await press('ArrowLeft');
  await page.waitForTimeout(300);
  check((await playhead()) === 29, 'playhead one frame before the title');
  const before = await brightInPreview('before');
  await press('ArrowRight', 11);
  await page.waitForTimeout(300);
  const during = await brightInPreview('during');
  check(during > before + 200, `the Program monitor draws the title (${before} → ${during} bright pixels)`);
  const box = await page.locator('.title-box').boundingBox();
  check(box && box.width > 50 && box.height > 10, 'the selected title has a box on the picture');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  const moved = await page.locator('.title-box').boundingBox();
  check(Math.abs(moved.y - box.y - 60) < 3, `dragging the title on the picture moves it (${(moved.y - box.y).toFixed(0)} px)`);

  step('Volume line on the dialogue clip');
  const a1 = page.locator('[data-testid="track-A1"] ~ .tl-lane [data-testid="clip"]').first();
  const vol = a1.locator('.clip-volume');
  const vb = await vol.boundingBox();
  await page.mouse.move(vb.x + 30, vb.y + vb.height / 2);
  await page.mouse.down();
  await page.mouse.move(vb.x + 30, vb.y + vb.height / 2 + 12, { steps: 5 });
  await page.mouse.up();
  const db = await a1.locator('.clip-db').textContent();
  check(/^-\d+(\.\d)? dB$/.test(db ?? ''), `dragging the line down lowers the volume (${db})`);

  step('Noise reduction');
  await page.click('[data-testid="denoise-toggle"]');
  await page.waitForFunction(() => !document.body.innerText.includes('Cleaning up the audio'), null, { timeout: 60000 });
  check(await a1.locator('[aria-label="Noise reduction"]').count() === 1, 'clip shows the noise-reduction badge and the cleaned audio is ready');

  step('Normalize loudness');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tab-media"]');
  await page.waitForSelector('[data-testid="normalize"]');
  await page.click('[data-testid="normalize"]');
  await page.waitForFunction(() => document.body.innerText.includes('Measured'), null, { timeout: 60000 });
  const hint = await page.textContent('.inspector');
  check(/about -1[34]\.\d LUFS|about -1[0-9]\.\d LUFS/.test(hint ?? ''), 'loudness measured and master gain set');
  await shot('22-sound');

  step('Export');
  const out = join(work, 'phase2.mp4');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, out);
  await press('Control+m');
  await page.click('[data-testid="export-start"]');
  await page.waitForSelector('[data-testid="export-output"]', { timeout: 240000 });
  check(existsSync(out), 'MP4 written');
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString());
  check(Math.abs(Number(info.format.duration) - 20) < 0.2, `length = the music (${Number(info.format.duration).toFixed(2)} s)`);
  // The title (white text) is on screen around 1 s.
  const y = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', out, '-vf', 'trim=start_frame=40:end_frame=41,scale=320:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  const bright = [...y.slice(110 * 320, 145 * 320)].filter((v) => v > 230).length;
  check(bright > 200, `title visible in the export (${bright} bright pixels in the middle band)`);
  await shot('23-exported');

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nALL PHASE 2 CHECKS PASSED');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (errors.length) console.error('Console errors:\n  ' + errors.join('\n  '));
  await shot('zz-phase2-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }).catch(() => {});
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  try {
    execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
  rmSync(work, { recursive: true, force: true });
}
