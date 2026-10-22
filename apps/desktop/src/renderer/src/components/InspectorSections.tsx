import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Trash2, Wand2 } from 'lucide-react';
import {
  DEFAULT_DUCK_DB,
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  TEXT_FONTS,
  TEXT_PRESETS,
  TRANSITION_LABELS,
  VIDEO_TRANSITIONS,
  YOUTUBE_LUFS,
  audioTracks,
  denoiseStep,
  effectiveFades,
  musicBeatFrames,
  previousAdjacent,
  trackLabel,
  updateClips,
  updateTrack,
  type Clip,
  type MediaItem,
  type TextAnimation,
  type TextContent,
  type Timeline,
  type TransitionType,
} from '@simplecut/core';
import { normalizeLoudness, removeTransition, resetLoudness, setDuckDepth, updateTransition } from '../actions/audio';
import { liveEdit } from '../actions/edit';
import { addBeatMarkersCmd, cutSelectionOnBeats, setMusicTrack } from '../actions/music';
import { applyPresetStyle } from '../actions/titles';
import { useAssets } from '../state/assets';
import { useProject } from '../state/project';

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

export function Row({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) {
  return (
    <div className="field" data-tip={tip}>
      <label>{label}</label>
      <div className="field-control">{children}</div>
    </div>
  );
}

/** Range slider that previews while dragging (via onChange) and shows its value. */
export function Slider(props: { value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void; testId?: string }) {
  return (
    <div className="slider-row">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        data-testid={props.testId}
      />
      <span className="slider-value">{props.format(props.value)}</span>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode, string?][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label, tip]) => (
        <button key={v} type="button" className={value === v ? 'on' : ''} onClick={() => onChange(v)} data-tip={tip}>
          {label}
        </button>
      ))}
    </div>
  );
}

const secs = (frames: number, fps: number) => `${(frames / fps).toFixed(2)} s`;

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export function TransitionSection({ tl, clipId, edge }: { tl: Timeline; clipId: string; edge: 'in' | 'out' }) {
  const clip = tl.clips[clipId];
  const t = edge === 'in' ? clip?.transitionIn : clip?.transitionOut;
  if (!clip || !t) return null;
  const fps = tl.settings.fps;
  const audio = clip.kind === 'audio';
  const where = edge === 'in' ? (previousAdjacent(tl, clip) ? 'Between two clips' : 'Clip fades in') : 'Clip fades out';
  return (
    <div className="section">
      <h4>Transition</h4>
      <Row label="Where">
        <div className="value">{where}</div>
      </Row>
      {!audio && (
        <Row label="Type">
          <select value={t.type} onChange={(e) => updateTransition(clipId, edge, { type: e.target.value as TransitionType })} data-testid="transition-type">
            {VIDEO_TRANSITIONS.map((v) => (
              <option key={v} value={v}>
                {TRANSITION_LABELS[v]}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row label="Length">
        <Slider
          value={t.duration}
          min={2}
          max={fps * 4}
          step={1}
          format={(v) => secs(v, fps)}
          onChange={(v) => liveEdit('Transition length', (tl2) => {
            const c = tl2.clips[clipId];
            const cur = edge === 'in' ? c?.transitionIn : c?.transitionOut;
            if (!c || !cur) return tl2;
            return { ...tl2, clips: { ...tl2.clips, [clipId]: { ...c, [edge === 'in' ? 'transitionIn' : 'transitionOut']: { ...cur, duration: v } } } };
          })}
        />
      </Row>
      <div className="hint">{audio ? 'A constant-power crossfade: no dip in loudness.' : 'You can also drag either edge of the transition on the timeline.'}</div>
      <div className="actions">
        <button type="button" className="btn danger" onClick={() => removeTransition(clipId, edge)} data-kbd="Delete" data-tip="Remove transition">
          <Trash2 size={13} /> Remove
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio clip: volume, fades, noise reduction
// ---------------------------------------------------------------------------

export function AudioClipSection({ tl, clips, media }: { tl: Timeline; clips: Clip[]; media?: MediaItem }) {
  const first = clips[0]!;
  const fps = tl.settings.fps;
  const ids = clips.map((c) => c.id);
  const fades = effectiveFades(first);
  const denoise = first.denoise ?? 0;
  const step = String(denoiseStep(denoise));
  const status = useAssets((s) => (media ? s.byPath[media.path]?.denoise?.[step] : undefined));
  return (
    <div className="section">
      <h4>Audio{clips.length > 1 ? ` · ${clips.length} clips` : ''}</h4>
      <Row label="Volume" tip="Also: drag the line on the clip up or down">
        <Slider
          value={first.volumeDb ?? 0}
          min={MIN_VOLUME_DB}
          max={MAX_VOLUME_DB}
          step={0.5}
          format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
          onChange={(v) => liveEdit('Volume', (t) => updateClips(t, ids, { volumeDb: v === 0 ? undefined : v }))}
          testId="clip-volume"
        />
      </Row>
      <Row label="Fade in" tip="Also: drag the handle at the clip's top-left corner">
        <Slider
          value={fades.fadeIn}
          min={0}
          max={Math.min(first.duration, fps * 10)}
          step={1}
          format={(v) => secs(v, fps)}
          onChange={(v) => liveEdit('Fade in', (t) => updateClips(t, ids, { fadeIn: v || undefined }))}
        />
      </Row>
      <Row label="Fade out" tip="Also: drag the handle at the clip's top-right corner">
        <Slider
          value={fades.fadeOut}
          min={0}
          max={Math.min(first.duration, fps * 10)}
          step={1}
          format={(v) => secs(v, fps)}
          onChange={(v) => liveEdit('Fade out', (t) => updateClips(t, ids, { fadeOut: v || undefined }))}
        />
      </Row>
      <Row label="Noise">
        <label className="toggle" data-tip="Removes steady background noise (fans, hum, wind, hiss)">
          <input
            type="checkbox"
            checked={denoise > 0}
            onChange={(e) => liveEdit('Reduce noise', (t) => updateClips(t, ids, { denoise: e.target.checked ? 0.5 : undefined }))}
            data-testid="denoise-toggle"
          />
          <Wand2 size={13} /> Reduce background noise
        </label>
      </Row>
      {denoise > 0 && (
        <Row label="Strength">
          <Slider value={denoise} min={0.1} max={1} step={0.1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => liveEdit('Noise strength', (t) => updateClips(t, ids, { denoise: v }))} />
        </Row>
      )}
      {denoise > 0 && status?.state !== 'ready' && <div className="hint">Cleaning up the audio… {Math.round((status?.progress ?? 0) * 100)}% — you hear the original until it's ready.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Music track clip
// ---------------------------------------------------------------------------

export function MusicSection({ media }: { media: MediaItem | undefined }) {
  const beats = media?.beats;
  return (
    <div className="section">
      <h4>Music</h4>
      {!beats ? (
        <div className="hint">Finding the beat…</div>
      ) : beats.beats.length < 8 || beats.confidence < 0.15 ? (
        <div className="hint warn-text">No steady beat found in this song.</div>
      ) : (
        <>
          <Row label="Tempo">
            <div className="value mono">{Math.round(beats.bpm)} BPM</div>
          </Row>
          <Row label="Beats">
            <div className="value">
              {beats.beats.length} beats · {beats.downbeats.length} bars
            </div>
          </Row>
          <div className="hint">Beat ticks show on this clip (taller ones start a bar). Clips, cuts and the playhead snap to them; Shift+↑/↓ jumps beat to beat.</div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => addBeatMarkersCmd('downbeats')} data-tip="A timeline marker at the start of every bar">
              Mark every bar
            </button>
            <button type="button" className="btn" onClick={() => addBeatMarkersCmd('beats')} data-tip="A timeline marker on every beat">
              Mark every beat
            </button>
          </div>
          <div className="hint">Montage: select your gameplay or FPV clips; their Properties show Cut to the music.</div>
        </>
      )}
    </div>
  );
}

/**
 * On footage, while the music track has beats: cut the selected clips at every beat or bar.
 * (It lives here, on the clips being cut, because selecting them is what the cut acts on.)
 */
export function BeatCutSection() {
  const hasBeats = useProject((s) => musicBeatFrames(s.doc.timeline, s.doc.media).length > 0);
  if (!hasBeats) return null;
  return (
    <div className="section" data-testid="beat-cut-section">
      <h4>Cut to the music</h4>
      <div className="hint">Cuts the selected clips at every beat (or bar) of the music track. Then delete the pieces you don't want.</div>
      <div className="actions">
        <button type="button" className="btn" onClick={() => cutSelectionOnBeats('beats')} data-testid="cut-on-beats">
          Cut on beats
        </button>
        <button type="button" className="btn" onClick={() => cutSelectionOnBeats('downbeats')}>
          Cut on bars
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Title editor
// ---------------------------------------------------------------------------

export function TitleSection({ clip, fps }: { clip: Clip; fps: number }) {
  const text = clip.text!;
  const set = (patch: Partial<TextContent>, label = 'Edit title') =>
    liveEdit(label, (t) => {
      const c = t.clips[clip.id];
      return c?.text ? updateClips(t, [clip.id], { text: { ...c.text, ...patch } }) : t;
    });
  const [content, setContent] = useState(text.content);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setContent(text.content), [clip.id, text.content]);
  useEffect(() => {
    const focus = () => {
      areaRef.current?.focus();
      areaRef.current?.select();
    };
    window.addEventListener('scut:edit-title', focus);
    return () => window.removeEventListener('scut:edit-title', focus);
  }, []);
  const anims: [TextAnimation, string][] = [
    ['none', 'None'],
    ['fade', 'Fade'],
    ['slide', 'Slide'],
    ['pop', 'Pop'],
  ];
  return (
    <>
      <div className="section">
        <h4>Title</h4>
        <div style={{ padding: '0 12px 6px' }}>
          <textarea
            ref={areaRef}
            className="title-input"
            rows={Math.min(4, Math.max(2, content.split('\n').length))}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              set({ content: e.target.value }, 'Type title');
            }}
            placeholder="Type your title"
            data-testid="title-text"
          />
        </div>
        <Row label="Style">
          <select value="" onChange={(e) => e.target.value && applyPresetStyle(clip.id, TEXT_PRESETS.find((p) => p.id === e.target.value)!)}>
            <option value="">Apply a preset…</option>
            {TEXT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Font">
          <select value={text.font} onChange={(e) => set({ font: e.target.value }, 'Title font')}>
            {TEXT_FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Size">
          <Slider value={text.size} min={16} max={300} step={1} format={(v) => `${v}`} onChange={(v) => set({ size: v }, 'Title size')} />
        </Row>
        <Row label="Color">
          <div className="inline-controls">
            <input type="color" value={text.color} onChange={(e) => set({ color: e.target.value }, 'Title color')} />
            <button type="button" className={`icon-btn small${text.bold ? ' active' : ''}`} onClick={() => set({ bold: !text.bold }, 'Bold')} data-tip="Bold" aria-pressed={text.bold}>
              <Bold size={14} />
            </button>
            <button type="button" className={`icon-btn small${text.italic ? ' active' : ''}`} onClick={() => set({ italic: !text.italic }, 'Italic')} data-tip="Italic" aria-pressed={text.italic}>
              <Italic size={14} />
            </button>
            <Seg
              value={text.align}
              options={[
                ['left', <AlignLeft size={14} />, 'Align left'],
                ['center', <AlignCenter size={14} />, 'Center'],
                ['right', <AlignRight size={14} />, 'Align right'],
              ]}
              onChange={(v) => set({ align: v }, 'Title alignment')}
            />
          </div>
        </Row>
        <Row label="Position" tip="Or drag the title in the Program monitor">
          <div className="inline-controls">
            <span className="mini">X</span>
            <input type="range" min={0} max={1} step={0.005} value={text.x} onChange={(e) => set({ x: Number(e.target.value) }, 'Move title')} />
            <span className="mini">Y</span>
            <input type="range" min={0} max={1} step={0.005} value={text.y} onChange={(e) => set({ y: Number(e.target.value) }, 'Move title')} />
          </div>
        </Row>
      </div>
      <div className="section">
        <h4>Look</h4>
        <Row label="Outline">
          <div className="inline-controls">
            <input type="color" value={text.outlineColor} onChange={(e) => set({ outlineColor: e.target.value }, 'Outline color')} />
            <input type="range" min={0} max={30} step={1} value={text.outlineWidth} onChange={(e) => set({ outlineWidth: Number(e.target.value) }, 'Outline width')} />
            <span className="slider-value">{text.outlineWidth}</span>
          </div>
        </Row>
        <Row label="Shadow">
          <div className="inline-controls">
            <input type="checkbox" checked={text.shadow} onChange={(e) => set({ shadow: e.target.checked }, 'Shadow')} />
            <input type="color" value={text.shadowColor} onChange={(e) => set({ shadowColor: e.target.value }, 'Shadow color')} disabled={!text.shadow} />
            <input type="range" min={0} max={60} step={1} value={text.shadowBlur} onChange={(e) => set({ shadowBlur: Number(e.target.value) }, 'Shadow blur')} disabled={!text.shadow} />
          </div>
        </Row>
        <Row label="Box">
          <div className="inline-controls">
            <input type="checkbox" checked={text.box} onChange={(e) => set({ box: e.target.checked }, 'Background box')} />
            <input type="color" value={text.boxColor} onChange={(e) => set({ boxColor: e.target.value }, 'Box color')} disabled={!text.box} />
            <input type="range" min={0} max={1} step={0.05} value={text.boxOpacity} onChange={(e) => set({ boxOpacity: Number(e.target.value) }, 'Box opacity')} disabled={!text.box} />
          </div>
        </Row>
        <Row label="Animate in">
          <Seg value={text.animIn} options={anims} onChange={(v) => set({ animIn: v }, 'Title animation')} />
        </Row>
        <Row label="Animate out">
          <Seg value={text.animOut} options={anims} onChange={(v) => set({ animOut: v }, 'Title animation')} />
        </Row>
        <Row label="Length">
          <div className="value mono">{secs(clip.duration, fps)}</div>
        </Row>
        <div className="hint">Drag the title's edges on the timeline to make it longer or shorter.</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Mix: loudness, ducking, track volumes
// ---------------------------------------------------------------------------

export function MixSection({ tl }: { tl: Timeline }) {
  const tracks = audioTracks(tl);
  const music = tracks.find((t) => t.music);
  const duck = tl.duckDb ?? DEFAULT_DUCK_DB;
  return (
    <div className="section">
      <h4>Sound</h4>
      <Row label="Loudness">
        <div className="inline-controls">
          <button type="button" className="btn" onClick={() => void normalizeLoudness()} data-testid="normalize" data-tip="Measures the whole mix and sets it to YouTube's −14 LUFS without clipping">
            Normalize for YouTube
          </button>
          {tl.masterGainDb != null && (
            <button type="button" className="btn ghost" onClick={resetLoudness} data-tip="Back to the original level">
              Reset
            </button>
          )}
        </div>
      </Row>
      {tl.loudness && (
        <div className="hint">
          Measured {tl.loudness.integratedLufs.toFixed(1)} LUFS · gain {tl.masterGainDb != null && tl.masterGainDb >= 0 ? '+' : ''}
          {(tl.masterGainDb ?? 0).toFixed(1)} dB → about {(tl.loudness.integratedLufs + (tl.masterGainDb ?? 0)).toFixed(1)} LUFS (target {YOUTUBE_LUFS}). Re-run after big changes.
        </div>
      )}
      {music && (
        <Row label="Music ducks" tip="How much the music drops while someone is talking">
          <Slider value={duck} min={-24} max={0} step={1} format={(v) => (v === 0 ? 'Off' : `${v} dB`)} onChange={(v) => setDuckDepth(v)} />
        </Row>
      )}
      {tracks.map((t) => (
        <Row key={t.id} label={`${trackLabel(tl, t.id)}${t.music ? ' ♪' : ''}`}>
          <Slider
            value={t.volumeDb ?? 0}
            min={MIN_VOLUME_DB}
            max={MAX_VOLUME_DB}
            step={0.5}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
            onChange={(v) => liveEdit('Track volume', (x) => updateTrack(x, t.id, { volumeDb: v || undefined }))}
          />
        </Row>
      ))}
      {!music && (
        <div className="hint">
          Tip: add a song with the ♪ button (or make a track the music track with its ♪ toggle) to get beat markers and automatic ducking.
          <button type="button" className="btn ghost" style={{ marginTop: 6 }} onClick={() => tracks[1] && setMusicTrack(tracks[1].id, true)}>
            Use A2 as the music track
          </button>
        </div>
      )}
    </div>
  );
}
