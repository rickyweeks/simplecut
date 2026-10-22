import { memo } from 'react';
import { AudioLines, Blend, MoveHorizontal, Square, SquareDashed } from 'lucide-react';
import { TEXT_PRESETS, TRANSITION_LABELS, type TextPreset, type TransitionType } from '@simplecut/core';
import { applyDefaultTransition } from '../actions/audio';
import { addPresetTitle } from '../actions/titles';
import { TITLE_MIME, TRANSITION_MIME } from '../lib/api';
import { renderText } from '../text/renderText';

const previews = new Map<string, string>();

/** A small picture of a title preset on a dark backdrop, drawn with the real title renderer. */
function presetPreview(p: TextPreset): string {
  let url = previews.get(p.id);
  if (url) return url;
  const W = 640;
  const H = 360;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a2338');
  g.addColorStop(1, '#2d1a33');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(renderText(p.text, W, H).canvas, 0, 0);
  url = c.toDataURL('image/jpeg', 0.85);
  previews.set(p.id, url);
  return url;
}

export const TitlesGrid = memo(function TitlesGrid() {
  return (
    <div className="bin-grid">
      {TEXT_PRESETS.map((p) => (
        <div
          key={p.id}
          className="bin-item"
          draggable
          data-testid="title-preset"
          data-tip={`${p.description} — drag onto the timeline, or double-click to add at the playhead`}
          onDragStart={(e) => {
            e.dataTransfer.setData(TITLE_MIME, p.id);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onDoubleClick={() => addPresetTitle(p)}
        >
          <div className="bin-thumb">
            <img src={presetPreview(p)} alt="" draggable={false} />
          </div>
          <div className="bin-name">{p.name}</div>
        </div>
      ))}
    </div>
  );
});

const TRANSITIONS: { type: TransitionType; icon: React.ReactNode; text: string }[] = [
  { type: 'dissolve', icon: <Blend size={18} />, text: 'Blends one shot into the next. The default (Ctrl+D).' },
  { type: 'dipBlack', icon: <Square size={18} fill="currentColor" />, text: 'Fades to black, then up into the next shot.' },
  { type: 'dipWhite', icon: <SquareDashed size={18} />, text: 'Flashes to white between shots.' },
  { type: 'slide', icon: <MoveHorizontal size={18} />, text: 'The next shot pushes the old one off to the left.' },
  { type: 'crossfade', icon: <AudioLines size={18} />, text: 'Smooth audio crossfade (Shift+Ctrl+D).' },
];

export function TransitionsList() {
  return (
    <div className="transition-list">
      {TRANSITIONS.map((t) => (
        <div
          key={t.type}
          className="transition-item"
          draggable
          data-testid="transition-item"
          data-tip="Drag onto the start or end of a clip, or click to add at the cut nearest the playhead"
          onDragStart={(e) => {
            e.dataTransfer.setData(TRANSITION_MIME, t.type);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => applyDefaultTransition(t.type === 'crossfade' ? 'audio' : 'video', t.type)}
        >
          <div className="transition-icon">{t.icon}</div>
          <div>
            <div className="transition-name">{TRANSITION_LABELS[t.type]}</div>
            <div className="transition-text">{t.text}</div>
          </div>
        </div>
      ))}
      <div className="hint" style={{ padding: '8px 4px' }}>
        Drag a transition's edges on the timeline to make it longer or shorter. Select it and press Delete to remove it.
      </div>
    </div>
  );
}
