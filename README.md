# SimpleCut

A beginner-friendly video editor for YouTube on Windows: "Premiere Pro with the fluff removed".
Same core shortcuts and source/program workflow as Premiere, but only what simple YouTube edits need.
Dark UI: true black behind the picture and between panels, charcoal panels and controls.

**Status: all four phases are complete** — core editing; audio, music beats, titles and
transitions; transforms, speed, color and talking-head tools; captions, Shorts, chapters,
thumbnails and export presets.

---

## Install (to try it)

Download `SimpleCut-Setup-<version>.exe` from this repository's **Releases** page and run it.
The installer isn't code-signed, so Windows may show "Windows protected your PC": click
**More info → Run anyway**. SimpleCut installs for your user only (no admin needed) and adds a
Start menu shortcut. The first launch shows a short tutorial.

## Requirements (to build from source)

- Windows 10 or 11, 64-bit
- [Node.js](https://nodejs.org) **22.12+** (24 LTS recommended)
- pnpm 10: `npm install -g pnpm@10` (or `corepack enable` from an admin terminal)
- Keep the repository at a reasonably short path (e.g. `C:\dev\simplecut`). Chromium and the NSIS
  installer builder can't open files whose full path exceeds 260 characters, and a deeply nested
  folder pushes files inside `node_modules` and `release\win-unpacked` past that limit.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm install` downloads Electron and the FFmpeg binaries (`ffmpeg-static`, `ffprobe-static`);
`pnpm dev` copies them into `apps/desktop/resources/bin`, downloads the pinned whisper.cpp
engine for auto captions (official `whisper-bin-x64.zip` release, SHA-256 checked, 12 MB after
unpacking) into `resources/bin/whisper`, and starts the app with hot reload.

## Test it

```bash
pnpm test
```

Runs the core unit tests (timeline model, edits, undo/redo, project files, export graph builder,
beat detection on synthetic songs, mixing, transitions, titles) and the export integration tests,
which render real MP4s with the bundled FFmpeg (software, plus GPU encode/decode when a hardware
encoder is present) and check them frame by frame. The Phase 2 integration tests compare exported
dissolves, dips, slides and titles against the preview's math, and measure exported volume, fades,
crossfades, ducking and loudness. The Phase 3/4 ones check a color grade (with an imported LUT)
against the core color math, picture-in-picture placement and rounded corners, smooth zoom, 2×
speed frame by frame and its pitch, reverse, thumbnail grabs, MP3 export, silence detection, and
real auto captions with whisper.cpp.

The caption tests need the speech model in `apps/desktop/.models/` (git-ignored; they are skipped
without it):

```bash
curl -L -o apps/desktop/.models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

```bash
pnpm e2e
```

Builds the app and runs the end-to-end scenarios: the Phase 1 acceptance test, the extras
(VFR proxy, real-time playback, a 30-minute 200-clip project's drag smoothness, crash recovery),
Phase 2 (Ctrl+D, Add music with beat detection and Shift+↓ beat jumps, undo/redo, a title
typed and dragged on the picture, the volume line, noise reduction, loudness, and an export that
contains all of it), and Phases 3/4 (the first-launch tutorial, removing pauses, auto captions
including the model prompt, picture-in-picture moved and resized on the picture, a color look,
Paste Attributes, speed, reverse, a thumbnail grab, Shorts mode with a vertical export plus .srt,
and an MP3 export). The Phase 3/4 test makes its talking clip with Windows' built-in voice.

The end-to-end tests drive the real Electron app with Playwright (only native file dialogs are
stubbed) and write screenshots to `apps/desktop/e2e-output/`. The acceptance test imports media,
marks In/Out, inserts with `,`, puts B-roll video only on V2, drags music to A2, cuts with the
razor, ripple deletes, uses Q/W, undoes/redoes, saves, exports, and then checks the MP4 frame by
frame against the source and against the preview.

## Build the Windows installer

```bash
pnpm dist
```

Produces `apps/desktop/release/SimpleCut-Setup-<version>.exe` (NSIS, per-user install, lets you
choose the folder, registers `.scut` files).

---

## How to use it

1. **Import**: drag videos onto the window (or `Ctrl+I`).
2. **Pick the good part**: double-click a clip in the Media bin. In the Source monitor, play with
   `J K L` / `Space`, press `I` at the start and `O` at the end.
3. **Put it on the timeline**: `,` inserts at the playhead (pushes later clips along), `.`
   overwrites. Or drag it (the film-strip handle drags video only, the waveform handle audio only).
4. **Cut**: `C` for the razor, `V` to select, `Delete` removes a clip and closes the gap.
   `Q`/`W` trim the clip under the playhead to the playhead. `Ctrl+K` cuts every track.
5. **Transitions**: put the playhead on a cut and press `Ctrl+D` (cross dissolve) or
   `Shift+Ctrl+D` (audio crossfade), or drag one from the **Transitions** tab onto a clip edge.
   Drag a transition's edges to change its length.
6. **Titles**: double-click a style in the **Titles** tab (or press `T` and click the picture),
   type in the Inspector, drag the title around on the Program monitor.
7. **Sound**: drag the line across an audio clip to change its volume, drag the corner handles to
   fade. The Inspector has noise reduction per clip and **Normalize for YouTube** (−14 LUFS).
8. **Music & beats**: the **♪ Add music** button puts a song on the music track and finds its
   beats. Beat ticks show on the clip, clips snap to them, `Shift+↑`/`Shift+↓` jump beat to
   beat, and *Cut selected on beats* chops gameplay/FPV footage into a montage. The music ducks
   automatically while people talk.
9. **Position & size**: select a clip and use the Inspector, or drag it on the Program monitor
   (corners resize, the knob rotates). One click makes a **picture-in-picture** facecam in any
   corner; **Punch-in** zooms to 110 % / 125 %, or **Smooth** zooms slowly across the clip.
10. **Speed & reverse**: 0.5× to 2× or any custom speed (`Ctrl+R`); the sound keeps its pitch.
    **Reverse** plays a clip backwards.
11. **Color**: **Auto Color**, five sliders, eight looks and your own `.cube` LUTs. Copy a clip
    (`Ctrl+C`), select others and press `Ctrl+Alt+V` to paste its color (or audio, size, title style).
12. **Talking-head videos**: select the clip and press **Find pauses** (Inspector). The pauses
    show in red; click any you want to keep, then **Remove**.
13. **YouTube extras** (Inspector, with nothing selected): **Auto captions** (runs on your PC;
    the first time it downloads a 141 MB speech model after asking), **Make it a Short** (9:16),
    **Copy chapters** from markers ticked as chapters, and **Save frame** for a thumbnail
    (`Ctrl+Shift+E`).
14. **Export**: the big **Export for YouTube** button (`Ctrl+M`). Pick YouTube, 4K, 1080p, Shorts,
    MP3 or WAV; captions are saved as an `.srt` next to the video.

A short tutorial walks you through the basics the first time you open SimpleCut (Settings →
*Show the tutorial again*).

Hold `?` anywhere for every shortcut; every tooltip shows its shortcut too.

---

## Architecture

```
simplecut/
├─ packages/core/            ← shared, platform-independent (plain TypeScript)
│  ├─ src/types.ts           timeline data model
│  ├─ src/timeline/          edit operations: insert, overwrite, ripple, lift/extract,
│  │                         razor, Q/W, trims, move/duplicate/paste, link/group, snapping,
│  │                         transitions, music track, speed, transforms, Paste Attributes
│  ├─ src/audio/             beat detection, mixing rules (gain, fades, crossfades,
│  │                         ducking, loudness, noise reduction)
│  ├─ src/text/              title presets, styles and animations
│  ├─ src/color/             color grades baked into one 3D LUT, .cube parsing, Auto Color
│  ├─ src/captions/          whisper output → timed words → captions, styles, .srt
│  ├─ src/history.ts         unlimited undo/redo
│  ├─ src/project/           .scut read/write, portable paths, project document helpers
│  ├─ src/media/             ffprobe parsing + VFR detection, proxy rules, waveform/thumbnail
│  │                         args, chunked reverse
│  ├─ src/export/            timeline → FFmpeg filter graph, encoders, YouTube presets, export
│  │                         presets, thumbnails, chapters, progress
│  ├─ src/platform.ts        interfaces every platform implements
│  └─ test/                  unit tests (vitest)
└─ apps/desktop/             ← Windows app (Electron + React + Vite)
   ├─ src/main/              FFmpeg runner, hardware encoder detection, media cache
   │                         (proxies, waveforms, thumbnails, beats, cleaned-up audio),
   │                         beat-detection worker thread, exporter, captions (model
   │                         download + whisper.cpp), scut:// media protocol, atomic file
   │                         I/O, crash recovery, IPC
   ├─ src/preload/           the typed `window.scut` bridge (contextIsolation + sandbox)
   ├─ src/shared/api.ts      IPC contract shared by main, preload and renderer
   ├─ src/renderer/          UI (React + Zustand) and the real-time preview engine (canvas
   │                         compositor, WebGL2 color, Web Audio mixer)
   ├─ test/                  export integration tests with the real FFmpeg
   └─ e2e/                   Playwright end-to-end tests
```

### Shared core vs. Windows-specific

| Concern | Where | Notes |
|---|---|---|
| Timeline model, edit operations, undo/redo | `packages/core` | No Electron, Node or DOM APIs (enforced: the package compiles against the ES library only). |
| Project file format | `packages/core` | Paths stored relative to the project (plus an absolute fallback), forward slashes, versioned with migrations. |
| ffprobe parsing, proxy decisions, export graph builder | `packages/core` | Pure functions that produce argument lists; any FFmpeg (desktop binary, ffmpeg-kit on Android) can run them. |
| Platform interfaces | `packages/core/src/platform.ts` | `ProjectStorage`, `MediaProber`, `MediaAssetService`, `EncoderDetector`, `ExportRunner`. |
| File system, FFmpeg processes, GPU encoder detection, media cache | `apps/desktop/src/main` | Windows implementations of those interfaces. |
| Preview rendering and UI | `apps/desktop/src/renderer` | HTML5 `<video>` → canvas compositor, Web Audio mixer. |

A future Android app (e.g. React Native) reuses `packages/core` unchanged and implements the
platform interfaces with its own storage, FFmpeg and preview.

### Key design decisions

- **Integer frames everywhere.** Every timeline position is a whole frame at the timeline rate, so
  cuts always land on frame boundaries. Source In/Out marks are kept in seconds so they survive the
  timeline auto-matching the first clip's frame rate.
- **Immutable edits + snapshot history.** Each edit returns a new timeline that shares unchanged
  clips with the old one, so unlimited undo is cheap and the history list is just a list of states.
- **Premiere semantics where it matters.** Insert ripples all unlocked tracks; dragging overwrites
  (Ctrl inserts, Alt duplicates); Ctrl-dragging an edge ripple-trims; linked video/audio move and
  trim together (Alt for one side); locked tracks are never touched.
- **Ripple that never chops your music.** Ripple delete, Q/W and gap closing close the hole on every
  track that is *empty* in that range; a track with material spanning the cut (a music bed) is left
  alone. Extract (`'`) deliberately removes the range from every unlocked track.
- **Preview = export.** The preview compositor and the FFmpeg graph use the same rules: tracks
  stacked bottom-up, clips fitted (letterboxed) into the frame on black, audio summed without
  normalization. The e2e test checks a preview frame against the exported frame.
- **Proxies are invisible.** Variable-frame-rate (phone) footage, >1440p, very high bitrate and
  codecs Chromium can't play get a background proxy (constant frame rate, short GOP, no B-frames for
  snappy scrubbing). The UI only says "Optimizing for editing". Export always reads the originals.
- **Hardware encoding.** NVENC, Quick Sync and AMF are detected with a 5-frame test encode; the best
  one is used for proxies and exports, with automatic fallback to x264 if it ever fails.
- **Long edits export in chunks.** Above 40 simultaneous inputs the exporter renders chunks (final
  video codec + float PCM audio) and joins them with a stream copy, so a 200-clip project never opens
  hundreds of decoders at once.
- **Music is whatever you put on the music track.** Rather than guessing whether a clip is music,
  *Add music* puts the song on a dedicated music track; everything there gets beat detection
  (spectral-flux onsets, tempo by autocorrelation, dynamic-programming beat tracking, each beat
  snapped to the sharpest attack within a few ms), runs in a worker thread and is cached on disk.
  Beats are derived data: they're written into every undo snapshot instead of being an undo step.
- **Titles are pictures.** The renderer draws each title with the same canvas code for the preview
  and for export (as a transparent PNG), so text looks identical in both; animations are the same
  math in the preview and in FFmpeg expressions.
- **Transitions use real handles.** Dissolves and slides use media beyond the cut (FFmpeg `xfade`),
  dips overlay a full-frame color layer; the integration tests compare exported frames with the
  preview's formulas.
- **One shared picture geometry.** Where a transformed clip lands (size in whole pixels, crop,
  corners, border) is computed by the core and used by both the preview canvas and the export
  graph (crop → scale → rounded mask → border → rotate → opacity → place); a smooth zoom is a
  sub-pixel `perspective` magnification in the export. Masks and borders are drawn by the same
  canvas code for both.
- **Color is one LUT.** Every grade (imported LUT, exposure and white balance in linear light,
  contrast, saturation, look) is baked by the core into a 33³ table. The preview samples it as a
  WebGL2 3D texture, the export writes it as a `.cube` for FFmpeg's `lut3d` (both trilinear, both
  BT.709), so graded footage matches.
- **Speed is a source mapping.** A clip at speed s shows source frame `sourceIn + (f − start)·s`;
  the export uses `setpts` + `fps` (and pitch-keeping `atempo`) and the preview seeks to the very
  frame that picks. Reverse makes a reversed copy of just the part a clip uses (in short chunks,
  so memory stays bounded) and plays that forwards.
- **Captions run locally.** whisper.cpp (shipped, 12 MB) with the English base model (downloaded
  once, checksum-verified). Word times come from whisper's token-level DTW timestamps (its segment
  times drift after pauses); the speech is the mix without the music track.
- **Windows paths.** FFmpeg is spawned without a shell (arguments go through `CreateProcessW` as
  UTF-16), so spaces, non-ASCII names and long paths work; the tests use such paths on purpose.
  Project saves are atomic (temp file + rename).

### Project file (`.scut`)

A single human-readable JSON file:

```json
{
  "format": "simplecut-project",
  "version": 3,
  "project": { "id": "…", "name": "My Vlog" },
  "media": [{ "id": "…", "path": "footage/day 1.mp4", "absolutePath": "C:/Videos/footage/day 1.mp4", "durationSec": 612.4, "…": "…" }],
  "timeline": { "settings": { "format": "1080p", "fps": 30 }, "tracks": ["…"], "clips": { "…": "…" }, "markers": [] }
}
```

On open, media is looked for next to the project first, then at its original location; anything
still missing triggers the **Relink** dialog (locating one file finds the others in that folder).
Older projects (versions 1 and 2) open and are upgraded on the next save.

### Where things are stored

- Settings: `%APPDATA%\SimpleCut` (Local Storage)
- Proxies, waveforms, thumbnails, detected beats, noise-reduced audio, reversed copies:
  `%APPDATA%\SimpleCut\media-cache` (safe to delete; reversed clips are remade from the original
  if their copy is gone)
- The captions speech model: `%APPDATA%\SimpleCut\models`
- Crash-recovery autosaves (every 60 s while there are unsaved changes): `%APPDATA%\SimpleCut\recovery`

Set `SIMPLECUT_USER_DATA` to use another folder (used by the tests; also works as a portable mode).

---

## Phase 1 scope (done)

- Projects: new/open/save, autosave every 60 s, crash recovery, relink missing media
- Import MP4, MOV, MKV, WebM, MP3, WAV, AAC, M4A, PNG, JPG (drag and drop or dialog)
- ffprobe-based import, VFR detection with automatic constant-frame-rate proxies, background
  proxies for 4K/high-bitrate/unsupported codecs with progress
- Source monitor: J/K/L, frame stepping, I/O, insert/overwrite, V/A source toggles, video-only and
  audio-only drag handles
- Timeline: 3+3 tracks (+ more), linked A/V, selection and razor tools, move/trim/duplicate,
  ripple delete, Q/W, lift/extract, Ctrl+K, snapping, mute/solo/lock/hide, source patching,
  waveforms, filmstrip thumbnails, markers (label, color, chapter flag), zoom/scroll/scrub, black-gap
  highlighting, unlimited undo with a history list, grouping, copy/paste
- Program monitor: real-time composited playback, Full/½/¼ resolution
- Export for YouTube: H.264 MP4 + AAC at YouTube's recommended bitrates, whole timeline or In/Out,
  progress with ETA and size, cancel, hardware encoding with software fallback

## Phase 2 scope (done)

- Audio: clip volume (line on the clip + Inspector), fade in/out handles, constant-power audio
  crossfades, per-track volume, noise reduction per clip (FFmpeg `afftdn`, heard in the preview
  too), automatic music ducking under dialogue, one-click loudness normalization to −14 LUFS
  (peak-limited at −1 dBTP)
- Music: **Add music** button, a music track, beat and bar detection, beat ticks on the clip,
  snapping to beats, Shift+↑/↓ beat jumps, beat/bar markers, cut selected clips on beats or bars
- Titles: 8 presets (Big Title, Lower Third, Subscribe Callout, Chapter Card, Caption Box, Neon,
  Top Banner, Quote), font/size/color/bold/italic/alignment, outline, shadow, background box,
  fade/slide/pop in and out, drag on the picture with center snapping, T tool
- Transitions: cross dissolve, dip to black, dip to white, slide, audio crossfade; Ctrl+D /
  Shift+Ctrl+D, drag from the Transitions tab, resize on the timeline, Inspector controls
- Import also accepts FLAC and OGG

## Phase 3 scope (done)

- Transforms: position, size, rotation, crop, opacity, fit/fill, rounded corners, border; in the
  Inspector or by dragging on the Program monitor (move, corner resize, rotate knob, center snapping)
- Presets: picture-in-picture in any corner (border + rounded corners), punch-in 110 % / 125 %,
  smooth zoom
- Speed: 0.5× / 1× / 1.5× / 2× / custom with pitch-corrected audio; later clips follow; reverse
- Color: exposure, contrast, saturation, temperature, tint; Auto Color (white balance, exposure,
  contrast); 8 looks with adjustable strength; `.cube` LUT import (3D and 1D)
- Paste Attributes (`Ctrl+Alt+V`): color, audio, position/size, text style
- Remove pauses (auto jump cut): threshold, minimum length and padding; red regions to review;
  one-step removal that never chops the music track
- Beginner helpers: first-launch tutorial that follows what you do, `?` shortcut overlay, empty-
  state hints everywhere

## Phase 4 scope (done)

- Auto captions on this PC (whisper.cpp): one-time model download with consent, progress, five
  caption styles, a CC track of editable title clips, `.srt` export (alone or next to the video)
- Shorts mode: 9:16 timeline, full-frame clips fill and center-crop, drag to reframe
- Chapters: markers ticked as chapters become YouTube timestamps (copied to the clipboard), with
  warnings when YouTube would ignore them (fewer than 3, shorter than 10 s; 00:00 added for you)
- Thumbnail grab: the program frame at the playhead as a full-size PNG, rendered by the export graph
- Export presets: YouTube (timeline size), 4K, 1080p, Shorts 1080×1920, MP3, WAV

## Third-party components

FFmpeg (LGPL/GPL builds via `ffmpeg-static`), whisper.cpp (MIT) and its `ggml-base.en` model
(MIT, from the Whisper project), Electron, React, Zustand, lucide icons, react-resizable-panels.

## Known limitations

- HDR (HLG/PQ) footage is not tone-mapped yet; it previews and exports as SDR-tagged.
- The bundled `ffprobe-static` is an older FFmpeg 4.0 build; it reads all supported formats, but
  very new codecs may report less detail.
- Auto captions are English only (the English model is the most accurate at this size).
- A smooth zoom is magnified from the picture rendered at its smaller size in the export, so the
  zoomed-in end is a touch softer than a fixed punch-in of the same amount.
- Reverse makes a copy of the part of the file it reverses (high quality), which uses disk space
  in the media cache.
- Beat detection expects music with a steady beat (most pop, EDM, rock, hip-hop). Songs without
  one get no beat markers, and the app says so.
- Loudness normalization is a measurement: re-run it after big changes to the mix.
