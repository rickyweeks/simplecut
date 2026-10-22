import { useState } from 'react';
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Captions, Clipboard, Film, RotateCcw, Smartphone, Sparkles, Undo2, Wand2, X } from 'lucide-react';
import {
  CAPTION_STYLES,
  DEFAULT_GRADE,
  DEFAULT_SILENCE,
  LOOKS,
  MAX_SPEED,
  MIN_SPEED,
  SPEED_PRESETS,
  captionsTrack,
  chapterList,
  clipSpeed,
  clipsOnTrack,
  gradeFunction,
  hasZoom,
  transformOf,
  type ColorGrade,
  type Clip,
  type LookId,
  type MediaItem,
  type SilenceSettings,
  type Timeline,
} from '@simplecut/core';
import { openCaptions, setCaptionStyle, useCaptionJob } from '../actions/captions';
import { copyChaptersCmd, exportFrameCmd, exportSrtCmd } from '../actions/deliver';
import { findSilences } from '../actions/silences';
import {
  applyPip,
  applyPunchIn,
  autoColorCmd,
  importLutCmd,
  liveColor,
  liveTransform,
  resetColor,
  resetTransform,
  reverseSelected,
  setColor,
  setSpeed,
  setTransform,
} from '../actions/visual';
import { lutError, useLuts } from '../state/luts';
import { useUi } from '../state/ui';
import { Row, Seg, Slider } from './InspectorSections';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;

// ---------------------------------------------------------------------------
// Transform: position, size, rotation, crop, opacity, corners, border, presets
// ---------------------------------------------------------------------------

export function TransformSection({ clips }: { clips: Clip[] }) {
  const [more, setMore] = useState(false);
  if (!clips.length) return null;
  const ids = clips.map((c) => c.id);
  const t = transformOf(clips[0]!);
  const zoom = hasZoom(t);
  return (
    <div className="section" data-testid="transform-section">
      <h4>
        Position &amp; size
        <button type="button" className="icon-link" onClick={() => resetTransform(ids)} data-tip="Reset position, size, crop and corners">
          <RotateCcw size={13} />
        </button>
      </h4>
      <Row label="Presets" tip="Picture-in-picture: a facecam in a corner with a border and rounded corners">
        <div className="seg icons">
          <button type="button" onClick={() => applyPip(ids, 'topLeft')} data-tip="Picture-in-picture, top left" data-testid="pip-tl">
            <ArrowUpLeft size={14} />
          </button>
          <button type="button" onClick={() => applyPip(ids, 'topRight')} data-tip="Picture-in-picture, top right">
            <ArrowUpRight size={14} />
          </button>
          <button type="button" onClick={() => applyPip(ids, 'bottomLeft')} data-tip="Picture-in-picture, bottom left">
            <ArrowDownLeft size={14} />
          </button>
          <button type="button" onClick={() => applyPip(ids, 'bottomRight')} data-tip="Picture-in-picture, bottom right" data-testid="pip-br">
            <ArrowDownRight size={14} />
          </button>
        </div>
      </Row>
      <Row label="Punch-in" tip="Zoom in for emphasis: a fixed closer framing, or a slow zoom across the clip">
        <div className="seg">
          <button type="button" onClick={() => applyPunchIn(ids, 1.1, false)}>110%</button>
          <button type="button" onClick={() => applyPunchIn(ids, 1.25, false)} data-testid="punch-125">
            125%
          </button>
          <button type="button" className={zoom ? 'on' : ''} onClick={() => applyPunchIn(ids, 1.25, true)} data-tip="Smoothly zoom from 100% to 125% over the clip" data-testid="smooth-zoom">
            Smooth
          </button>
        </div>
      </Row>
      <Row label="Size">
        <Slider value={t.scale} min={0.1} max={4} step={0.01} format={pct} onChange={(v) => liveTransform(ids, { scale: v, ...(zoom ? { zoomTo: t.zoomTo! * (v / t.scale) } : {}) }, 'Size')} testId="transform-scale" />
      </Row>
      <Row label="X">
        <Slider value={t.x} min={-0.5} max={1.5} step={0.001} format={(v) => `${Math.round((v - 0.5) * 100)}`} onChange={(v) => liveTransform(ids, { x: v }, 'Position')} testId="transform-x" />
      </Row>
      <Row label="Y">
        <Slider value={t.y} min={-0.5} max={1.5} step={0.001} format={(v) => `${Math.round((v - 0.5) * 100)}`} onChange={(v) => liveTransform(ids, { y: v }, 'Position')} />
      </Row>
      <Row label="Rotation">
        <Slider value={t.rotation} min={-180} max={180} step={0.5} format={(v) => `${v}°`} onChange={(v) => liveTransform(ids, { rotation: v }, 'Rotation')} />
      </Row>
      <Row label="Opacity">
        <Slider value={t.opacity} min={0} max={1} step={0.01} format={pct} onChange={(v) => liveTransform(ids, { opacity: v }, 'Opacity')} testId="transform-opacity" />
      </Row>
      <Row label="Fit" tip="Fit shows the whole picture (black bars if the shape differs); Fill covers the frame and crops the edges">
        <Seg value={t.fit} options={[['fit', 'Fit'], ['fill', 'Fill']]} onChange={(fit) => setTransform(ids, { fit }, fit === 'fill' ? 'Fill frame' : 'Fit frame')} />
      </Row>
      <button type="button" className="disclosure" onClick={() => setMore(!more)}>
        {more ? 'Fewer options' : 'Crop, corners and border'}
      </button>
      {more && (
        <>
          {(['cropLeft', 'cropRight', 'cropTop', 'cropBottom'] as const).map((k) => (
            <Row key={k} label={`Crop ${k.slice(4).toLowerCase()}`}>
              <Slider value={t[k]} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => liveTransform(ids, { [k]: v }, 'Crop')} />
            </Row>
          ))}
          <Row label="Corners">
            <Slider value={t.radius} min={0} max={0.5} step={0.01} format={pct} onChange={(v) => liveTransform(ids, { radius: v }, 'Rounded corners')} />
          </Row>
          <Row label="Border">
            <div className="slider-row">
              <input type="color" value={t.borderColor} onChange={(e) => liveTransform(ids, { borderColor: e.target.value }, 'Border color')} data-tip="Border color" />
              <Slider value={t.borderWidth} min={0} max={30} step={1} format={(v) => `${v}px`} onChange={(v) => liveTransform(ids, { borderWidth: v }, 'Border')} />
            </div>
          </Row>
        </>
      )}
      <div className="hint">Drag the picture on the Program monitor to move it, a corner to resize, the knob to rotate.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speed and reverse
// ---------------------------------------------------------------------------

export function SpeedSection({ clips, media }: { clips: Clip[]; media: Record<string, MediaItem> }) {
  const [custom, setCustom] = useState('');
  if (!clips.length) return null;
  const ids = clips.map((c) => c.id);
  const speed = clipSpeed(clips[0]!);
  const reversed = clips.some((c) => media[c.mediaId]?.derived);
  const isImage = clips.every((c) => media[c.mediaId]?.kind === 'image');
  if (isImage) return null;
  return (
    <div className="section" data-testid="speed-section">
      <h4>Speed</h4>
      <Row label="Speed" tip="Changes the clip's length; later clips move to follow. Sound keeps its pitch.">
        <div className="seg">
          {SPEED_PRESETS.map((s) => (
            <button key={s} type="button" className={Math.abs(speed - s) < 1e-6 ? 'on' : ''} onClick={() => setSpeed(ids, s)} data-testid={`speed-${s}`}>
              {s}×
            </button>
          ))}
        </div>
      </Row>
      <Row label="Custom">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(custom.replace('%', '')) / 100;
            if (v >= MIN_SPEED && v <= MAX_SPEED) setSpeed(ids, v);
            setCustom('');
          }}
        >
          <input type="text" inputMode="decimal" placeholder={`${Math.round(speed * 100)}%`} value={custom} onChange={(e) => setCustom(e.target.value)} data-testid="speed-custom" />
          <button type="submit" className="btn">
            Set
          </button>
        </form>
      </Row>
      <Row label="Direction">
        <button type="button" className={`btn${reversed ? ' on' : ''}`} onClick={() => void reverseSelected()} data-testid="reverse" data-tip="Play the clip backwards (and again to undo)">
          <Undo2 size={13} /> {reversed ? 'Reversed — play forwards' : 'Reverse'}
        </button>
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

const swatches = new Map<LookId, string>();
/** A small strip (sky, skin, foliage, shadows) through a look, so you can see what it does. */
function lookSwatch(look: LookId): string {
  let url = swatches.get(look);
  if (url) return url;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 36;
  const ctx = c.getContext('2d')!;
  const f = gradeFunction({ ...DEFAULT_GRADE, look, lookAmount: 1 });
  const img = ctx.createImageData(64, 36);
  const base = (x: number, y: number): [number, number, number] => {
    const t = y / 35;
    if (t < 0.4) return [0.35 + 0.2 * (x / 63), 0.55 + 0.15 * (x / 63), 0.85];
    if (t < 0.7) return x < 32 ? [0.85, 0.62, 0.5] : [0.3, 0.55, 0.25];
    return [0.12 + 0.25 * (x / 63), 0.11 + 0.2 * (x / 63), 0.1 + 0.18 * (x / 63)];
  };
  for (let y = 0; y < 36; y++) {
    for (let x = 0; x < 64; x++) {
      const [r, g, b] = f(...base(x, y));
      img.data.set([r * 255, g * 255, b * 255, 255], (y * 64 + x) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  url = c.toDataURL();
  swatches.set(look, url);
  return url;
}

export function ColorSection({ clips }: { clips: Clip[] }) {
  useLuts((s) => s.entries);
  if (!clips.length) return null;
  const ids = clips.map((c) => c.id);
  const g: ColorGrade = clips[0]!.color ?? DEFAULT_GRADE;
  const slider = (key: 'exposure' | 'contrast' | 'saturation' | 'temperature' | 'tint', label: string, min: number, max: number, step: number, format: (v: number) => string, tip?: string) => (
    <Row label={label} tip={tip}>
      <Slider value={g[key]} min={min} max={max} step={step} format={format} onChange={(v) => liveColor(ids, { [key]: v })} testId={`color-${key}`} />
    </Row>
  );
  const err = g.lut ? lutError(g.lut.path) : null;
  return (
    <div className="section" data-testid="color-section">
      <h4>
        Color
        <button type="button" className="icon-link" onClick={() => resetColor(ids)} data-tip="Reset color">
          <RotateCcw size={13} />
        </button>
      </h4>
      <div className="actions">
        <button type="button" className="btn" onClick={() => void autoColorCmd(ids)} data-testid="auto-color" data-tip="Fix white balance, brightness and contrast automatically">
          <Wand2 size={13} /> Auto Color
        </button>
      </div>
      {slider('exposure', 'Exposure', -3, 3, 0.05, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`, 'Brightness in stops')}
      {slider('contrast', 'Contrast', -100, 100, 1, signed)}
      {slider('saturation', 'Saturation', -100, 100, 1, signed, 'All the way left is black and white')}
      {slider('temperature', 'Temperature', -100, 100, 1, signed, 'Left is cooler (blue), right is warmer (orange)')}
      {slider('tint', 'Tint', -100, 100, 1, signed, 'Left is greener, right is more magenta')}
      <div className="look-grid" data-testid="looks">
        {LOOKS.map((l) => (
          <button key={l.id} type="button" className={`look${g.look === l.id ? ' on' : ''}`} onClick={() => setColor(ids, { look: l.id, lookAmount: l.id === 'none' ? 1 : g.look === 'none' ? 1 : g.lookAmount }, `Look: ${l.name}`)} data-tip={l.description} data-testid={`look-${l.id}`}>
            <img src={lookSwatch(l.id)} alt="" />
            <span>{l.name}</span>
          </button>
        ))}
      </div>
      {g.look !== 'none' && (
        <Row label="Look strength">
          <Slider value={g.lookAmount} min={0} max={1} step={0.01} format={pct} onChange={(v) => liveColor(ids, { lookAmount: v })} />
        </Row>
      )}
      <Row label="LUT" tip="A .cube file, e.g. your camera's log-to-normal conversion. Applied before everything else.">
        {g.lut ? (
          <div className="lut-chip">
            <span className={err ? 'warn-text' : ''} data-tip={err ?? g.lut.path}>
              {g.lut.name}
            </span>
            <button type="button" className="icon-link" onClick={() => setColor(ids, { lut: undefined }, 'Remove LUT')} data-tip="Remove the LUT">
              <X size={13} />
            </button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={() => void importLutCmd(ids)} data-testid="import-lut">
            Import .cube…
          </button>
        )}
      </Row>
      {err && <div className="hint warn-text">This LUT can't be read ({err}); the clip shows without it.</div>}
      <div className="hint">Copy a clip (Ctrl+C), select others and press Ctrl+Alt+V to paste its color onto them.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remove silences (talking-head jump cuts)
// ---------------------------------------------------------------------------

export function SilenceSection() {
  const review = useUi((s) => s.silences);
  const [s, setS] = useState<SilenceSettings>(review?.settings ?? DEFAULT_SILENCE);
  return (
    <div className="section" data-testid="silence-section">
      <h4>Remove pauses</h4>
      <Row label="Quieter than" tip="Anything quieter than this counts as a pause">
        <Slider value={s.thresholdDb} min={-60} max={-20} step={1} format={(v) => `${v} dB`} onChange={(v) => setS({ ...s, thresholdDb: v })} />
      </Row>
      <Row label="At least" tip="Only pauses at least this long are cut">
        <Slider value={s.minSec} min={0.2} max={3} step={0.05} format={(v) => `${v.toFixed(2)} s`} onChange={(v) => setS({ ...s, minSec: v })} />
      </Row>
      <Row label="Keep" tip="Breathing room left on each side of a cut">
        <Slider value={s.paddingSec} min={0} max={0.5} step={0.01} format={(v) => `${v.toFixed(2)} s`} onChange={(v) => setS({ ...s, paddingSec: v })} />
      </Row>
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => void findSilences(s)} data-testid="find-silences">
          <Sparkles size={13} /> Find pauses
        </button>
      </div>
      <div className="hint">Pauses show in red on the timeline. Click one to keep it, then press Remove. The music track is never cut.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline extras: Shorts, captions, chapters, thumbnail
// ---------------------------------------------------------------------------

export function YouTubeSection({ tl, onShorts }: { tl: Timeline; onShorts: (on: boolean) => void }) {
  const styleId = useCaptionJob((s) => s.styleId);
  const track = captionsTrack(tl);
  const captionCount = track ? clipsOnTrack(tl, track.id).length : 0;
  const chapters = tl.markers.filter((m) => m.chapter).length;
  const vertical = tl.settings.format === 'vertical';
  const list = chapters ? chapterList(tl) : null;
  return (
    <div className="section" data-testid="youtube-section">
      <h4>YouTube</h4>
      <Row label="Shorts" tip="A vertical 9:16 timeline: every clip fills the frame (center crop). Drag a clip on the picture to reframe it.">
        <button type="button" className={`btn${vertical ? ' on' : ''}`} onClick={() => onShorts(!vertical)} data-testid="shorts-toggle">
          <Smartphone size={13} /> {vertical ? 'Shorts mode on (9:16)' : 'Make it a Short'}
        </button>
      </Row>
      <Row label="Captions">
        <div className="actions tight">
          <button type="button" className="btn" onClick={() => void openCaptions()} data-testid="auto-captions">
            <Captions size={13} /> {captionCount ? 'Redo captions' : 'Auto captions'}
          </button>
          {captionCount > 0 && (
            <button type="button" className="btn ghost" onClick={() => void exportSrtCmd()} data-tip="Save the captions as subtitles to upload to YouTube">
              .srt
            </button>
          )}
        </div>
      </Row>
      {captionCount > 0 && (
        <Row label="Caption style">
          <select value={styleId} onChange={(e) => setCaptionStyle(e.target.value)} data-testid="caption-style">
            {CAPTION_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row label="Chapters" tip="Markers ticked as chapters become YouTube timestamps for your description">
        <button type="button" className="btn" onClick={() => void copyChaptersCmd()} disabled={!chapters} data-testid="copy-chapters">
          <Clipboard size={13} /> {chapters ? `Copy ${list!.count} chapters` : 'No chapter markers'}
        </button>
      </Row>
      {list?.problems.length ? <div className="hint warn-text">{list.problems[0]}</div> : null}
      <Row label="Thumbnail">
        <button type="button" className="btn" onClick={() => void exportFrameCmd()} data-tip="Save the frame at the playhead as a full-size PNG" data-kbd="Ctrl+Shift+E">
          <Film size={13} /> Save frame
        </button>
      </Row>
    </div>
  );
}
