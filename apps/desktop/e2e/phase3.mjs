/**
 * Phase 3 and 4 end-to-end test (run after `electron-vite build`):  node e2e/phase3.mjs
 *
 * Through the real UI: the first-launch tutorial, Remove Silences, auto captions (model
 * prompt, then transcription with the real whisper.cpp), picture-in-picture and dragging on
 * the picture, a color look, speed, reverse, Paste Attributes, a thumbnail grab, Shorts mode
 * with a vertical export plus .srt, and an MP3 export. Screenshots go to e2e-output/.
 *
 * Needs the speech model in apps/desktop/.models (the test links it in when it checks the
 * "needs download" prompt), and Windows' built-in speech voice to make the talking clip.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const model = join(appDir, '.models', 'ggml-base.en.bin');
if (!existsSync(model)) {
  console.error('The speech model is missing: put ggml-base.en.bin in apps/desktop/.models (see README).');
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'simplecut-p3-'));
const userData = join(work, 'user-data');
const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
const probe = (p) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', p]).toString());
const step = (n) => console.log(`\n▶ ${n}`);
function check(cond, msg) {
  if (!cond) throw new Error(`Check failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

step('Generating a talking clip (Windows voice, with pauses)');
const speech = join(work, 'speech.wav');
const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">Welcome back to the channel.<break time="1800ms"/>Today we are flying the new drone over the lake.<break time="1500ms"/>Here we go!</speak>`;
execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${speech}'); $s.SpeakSsml('${ssml}'); $s.Dispose()`,
]);
const talk = join(work, 'talk.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=30', '-i', speech, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk]);
const talkSec = Number(probe(talk).format.duration);
console.log(`  talk.mp4: ${talkSec.toFixed(2)} s`);

const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...process.env, SIMPLECUT_USER_DATA: userData, ELECTRON_RENDERER_URL: '' } });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const press = async (key, n = 1) => {
  for (let i = 0; i < n; i++) await page.keyboard.press(key);
};
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const tutorialTitle = () => page.$eval('[data-testid="tutorial"] h3', (e) => e.textContent).catch(() => null);
const clipsOn = (label) => page.locator(`[data-testid="track-${label}"] ~ .tl-lane [data-testid="clip"]`);
const stubSave = (p) => app.evaluate(({ dialog }, f) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
}, p);
const waitFile = async (p, ms = 60000) => {
  const t0 = Date.now();
  while (!existsSync(p)) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${p}`);
    await page.waitForTimeout(200);
  }
};
/** Mean RGB of the Program monitor's picture. */
async function programColor(name) {
  const png = join(work, `${name}.png`);
  await page.locator('[data-testid="program-canvas"]').screenshot({ path: png });
  const px = ff(['-i', png, '-vf', 'scale=64:36,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
  const m = [0, 0, 0];
  for (let i = 0; i < px.length; i += 3) for (let c = 0; c < 3; c++) m[c] += px[i + c];
  return m.map((v) => v / (px.length / 3));
}

try {
  await page.waitForSelector('[data-testid="timeline"]');

  step('First-launch tutorial follows along');
  await page.waitForSelector('[data-testid="tutorial"]', { timeout: 10000 });
  check((await tutorialTitle()) === 'Import your videos', 'step 1: import');
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, talk);
  await page.click('.topbar [aria-label="Import media"]');
  await page.waitForSelector('[data-testid="bin-item"]');
  await page.waitForSelector('[data-testid="source-monitor"] video');
  await page.waitForFunction(() => document.querySelector('[data-testid="tutorial"] h3')?.textContent === 'Mark the good part', null, { timeout: 5000 });
  check(true, 'step 2 after importing (the clip opens in Source): mark In and Out');
  await page.dblclick('[data-testid="bin-item"]'); // focuses the Source monitor for I / O
  await page.waitForTimeout(400);
  await press('Home');
  await press('i');
  await press('End');
  await press('o');
  await page.waitForFunction(() => document.querySelector('[data-testid="tutorial"] h3')?.textContent === 'Put it on the timeline', null, { timeout: 5000 });
  check(true, 'step 3 after marking: insert');
  await press(',');
  await page.waitForFunction(() => document.querySelector('[data-testid="tutorial"] h3')?.textContent === 'Cut out mistakes', null, { timeout: 5000 });
  check(true, 'step 4 after inserting: cut');
  await shot('30-tutorial');
  await page.click('[data-testid="program-tc"]');
  await press('Home');
  await press('Shift+ArrowRight', 2);
  await press('Control+z'); // keep the clip whole for the next steps; the tutorial only needs one cut
  await press('Control+Shift+z');
  await press('Control+k');
  await page.waitForFunction(() => document.querySelector('[data-testid="tutorial"] h3')?.textContent === 'Export for YouTube', null, { timeout: 5000 });
  check(true, 'step 5 after cutting: export');
  await press('Control+m');
  await page.waitForSelector('[data-testid="export-dialog"]');
  await page.waitForSelector('[data-testid="tutorial"]', { state: 'detached', timeout: 5000 });
  check(true, 'opening Export finishes the tutorial');
  await press('Escape');
  await press('Control+z'); // undo the tutorial's cut
  check((await clipsOn('V1').count()) === 1, 'one talking clip on V1');

  step('Remove pauses');
  await clipsOn('A1').first().click({ position: { x: 40, y: 30 } });
  await page.click('[data-testid="find-silences"]');
  await page.waitForSelector('[data-testid="silence-region"]', { timeout: 30000 });
  const regions = await page.locator('[data-testid="silence-region"]').count();
  check(regions >= 2, `found the pauses (${regions})`);
  await shot('31-silences');
  const lengthBefore = await page.textContent('.tl-corner');
  await page.click('[data-testid="remove-silences"]');
  await page.waitForSelector('[data-testid="silence-region"]', { state: 'detached' });
  const lengthAfter = await page.textContent('.tl-corner');
  check(lengthAfter < lengthBefore && (await clipsOn('V1').count()) >= 3, `pauses removed from picture and sound (${lengthBefore} → ${lengthAfter}, ${await clipsOn('V1').count()} pieces)`);

  step('Auto captions: model prompt, then real transcription');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="auto-captions"]');
  await page.waitForSelector('[data-testid="captions-download"]', { timeout: 10000 });
  const offer = await page.textContent('[data-testid="captions-download"]');
  check(/141\.\d MB|148 MB|141 MB/.test(offer ?? ''), `offers the one-time model download first (${offer?.trim()})`);
  await page.keyboard.press('Escape');
  // Instead of downloading 148 MB in a test, put the verified model where the app keeps it.
  mkdirSync(join(userData, 'models'), { recursive: true });
  linkSync(model, join(userData, 'models', 'ggml-base.en.bin'));
  await page.click('[data-testid="auto-captions"]');
  await page.click('[data-testid="caption-style-boxed"]');
  await page.click('[data-testid="captions-create"]');
  await page.waitForSelector('[data-testid="captions-done"]', { timeout: 120000 });
  check(true, (await page.textContent('[data-testid="captions-done"]')) ?? '');
  await page.keyboard.press('Escape');
  const caps = await page.locator('.clip.text').allTextContents();
  check(caps.length >= 2 && caps.join(' ').toLowerCase().includes('welcome back'), `captions on their own track (${caps.length}: "${caps[0]?.slice(0, 40)}…")`);
  // A caption is drawn on the picture (white text on a dark box near the bottom).
  await page.click('[data-testid="program-tc"]');
  await press('Home');
  await press('Shift+ArrowRight', 6);
  await page.waitForTimeout(400);
  await shot('32-captions');

  step('A color look changes the preview');
  await clipsOn('V1').first().click({ position: { x: 30, y: 30 } });
  await page.waitForSelector('[data-testid="color-section"]');
  const before = await programColor('before-look');
  await page.click('[data-testid="look-bw"]');
  await page.waitForTimeout(500);
  const after = await programColor('after-look');
  const spread = (c) => Math.max(...c) - Math.min(...c);
  check(spread(after) < spread(before) * 0.35, `Black & White drains the color (channel spread ${spread(before).toFixed(1)} → ${spread(after).toFixed(1)})`);
  check(await clipsOn('V1').first().locator('[aria-label="Color"]').count() === 1, 'clip shows the color badge');

  step('Picture-in-picture, then drag it on the picture');
  await page.waitForSelector('[data-testid="transform-section"]');
  await page.click('[data-testid="pip-br"]');
  const box = await page.locator('[data-testid="pic-box"]').boundingBox();
  const stage = await page.locator('[data-testid="picture-overlay"]').boundingBox();
  check(box && box.x > stage.x + stage.width / 2 && box.y > stage.y + stage.height / 2, 'PiP box sits in the bottom-right quarter');
  check(Math.abs(box.width / stage.width - 0.3) < 0.02, `PiP is 30% of the frame wide (${(box.width / stage.width).toFixed(3)})`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 8 });
  await page.mouse.up();
  const moved = await page.locator('[data-testid="pic-box"]').boundingBox();
  check(Math.abs(moved.x - (box.x - 120)) < 3 && Math.abs(moved.y - (box.y - 60)) < 3, 'dragging moves it');
  const h = await page.locator('[data-testid="pic-handle-se"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 40, h.y + h.height / 2 + 22, { steps: 6 });
  await page.mouse.up();
  const scaled = await page.locator('[data-testid="pic-box"]').boundingBox();
  check(scaled.width > moved.width * 1.05, `dragging a corner makes it bigger (${moved.width.toFixed(0)} → ${scaled.width.toFixed(0)} px)`);
  await shot('33-pip');

  step('Paste attributes');
  await press('Control+c');
  await clipsOn('V1').nth(1).click({ position: { x: 20, y: 30 } });
  await press('Control+Alt+v');
  await page.waitForSelector('[data-testid="paste-attributes"]');
  await page.uncheck('[data-testid="attr-transform"]');
  await page.click('[data-testid="attr-paste"]');
  check(await clipsOn('V1').nth(1).locator('[aria-label="Color"]').count() === 1, 'color pasted onto the next clip');
  check(await clipsOn('V1').nth(1).locator('[aria-label="Position and size"]').count() === 0, '…without its position and size (unticked)');

  step('Speed and reverse');
  const third = clipsOn('V1').nth(2);
  const w0 = (await third.boundingBox()).width;
  await third.click({ position: { x: 10, y: 30 } });
  await page.click('[data-testid="speed-2"]');
  const w1 = (await clipsOn('V1').nth(2).boundingBox()).width;
  check(Math.abs(w1 - w0 / 2) < 3, `2× halves the clip (${w0.toFixed(0)} → ${w1.toFixed(0)} px)`);
  check((await clipsOn('V1').nth(2).textContent()).includes('200%'), 'clip shows 200%');
  await page.click('[data-testid="reverse"]');
  await page.waitForSelector('[data-testid="clip"] [aria-label="Reversed"]', { timeout: 60000 });
  check(true, 'reversed (clip shows the reverse badge)');
  check((await page.locator('[data-testid="bin-item"]').count()) === 1, 'the reversed copy stays out of the Media bin');

  step('Thumbnail grab');
  const thumb = join(work, 'thumb.png');
  await stubSave(thumb);
  await page.click('[data-testid="export-frame"]');
  await waitFile(thumb);
  await page.waitForTimeout(300);
  const ts = probe(thumb).streams[0];
  check(ts.width === 1920 && ts.height === 1080, `full-size PNG (${ts.width}×${ts.height})`);

  step('Shorts mode and a vertical export with captions');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="shorts-toggle"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="program-monitor"]')?.textContent?.includes('1080×1920'));
  check(true, 'program monitor is 1080×1920');
  await shot('34-shorts');
  const short = join(work, 'short.mp4');
  await stubSave(short);
  await press('Control+m');
  await page.click('[data-testid="preset-shorts"]');
  check(await page.isChecked('[data-testid="export-srt"]'), '.srt option is on (captions exist)');
  await page.click('[data-testid="export-start"]');
  await page.waitForSelector('[data-testid="export-output"]', { timeout: 300000 });
  const vs = probe(short).streams.find((s) => s.codec_type === 'video');
  check(vs.width === 1080 && vs.height === 1920, `vertical MP4 (${vs.width}×${vs.height})`);
  const srt = readFileSync(join(work, 'short.srt'), 'utf8');
  check(/^1\r?\n00:00:0\d,\d{3} --> /.test(srt) && /welcome back/i.test(srt), '.srt saved next to it');
  await page.click('.modal .btn.primary');

  step('MP3 export');
  const mp3 = join(work, 'mix.mp3');
  await stubSave(mp3);
  await press('Control+m');
  await page.click('[data-testid="preset-mp3"]');
  await page.click('[data-testid="export-start"]');
  await page.waitForSelector('[data-testid="export-output"]', { timeout: 120000 });
  check(probe(mp3).streams.map((s) => s.codec_name).join() === 'mp3', 'MP3 with sound only');
  await shot('35-done');

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nALL PHASE 3/4 CHECKS PASSED');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (errors.length) console.error('Console errors:\n  ' + errors.join('\n  '));
  await shot('zz-phase3-failure').catch(() => {});
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
