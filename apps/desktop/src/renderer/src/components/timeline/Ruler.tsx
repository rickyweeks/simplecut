import { memo, useLayoutEffect, useRef, useState } from 'react';
import { blackGaps, snapFrame, snapTargets, updateMarker, type Marker, type Timeline } from '@simplecut/core';
import { seekProgram } from '../../actions/edit';
import { programEngine } from '../../playback/engine';
import { getPlayhead, usePlayhead } from '../../state/playhead';
import { getTimeline, useProject } from '../../state/project';
import { useUi } from '../../state/ui';

export const MARKER_HEX: Record<Marker['color'], string> = {
  green: '#3ddc97',
  red: '#ff4d5e',
  purple: '#b388ff',
  orange: '#ff9a3c',
  yellow: '#ffd84d',
  blue: '#4d8bff',
  cyan: '#3dd6e8',
  white: '#f2f2f2',
};

/** Picks a tick spacing (in frames) so labels are at least ~90 px apart. */
function tickSpacing(fps: number, px: number): { major: number; minor: number } {
  const candidates = [1, 2, 5, 10, fps / 2, fps, 2 * fps, 5 * fps, 10 * fps, 15 * fps, 30 * fps, 60 * fps, 120 * fps, 300 * fps, 600 * fps, 1800 * fps, 3600 * fps];
  const major = candidates.find((c) => Number.isInteger(c) && c * px >= 90) ?? 3600 * fps;
  // Subdivide by the first whole divisor, preferring fifths.
  const div = [5, 4, 6, 3, 2].find((d) => Number.isInteger(major / d) && (major / d) * px >= 6) ?? 1;
  return { major, minor: major / div };
}

function label(frame: number, fps: number, withFrames: boolean): string {
  const total = Math.floor(frame / fps);
  const ff = frame % fps;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const base = `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withFrames ? `${base}:${String(ff).padStart(2, '0')}` : base;
}

export const Ruler = memo(function Ruler({ tl, px, scrollLeft, width }: { tl: Timeline; px: number; scrollLeft: number; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const fps = tl.settings.fps;
  const selectedMarker = useUi((s) => s.selection.markerId);
  const [dragMarker, setDragMarker] = useState<{ id: string; frame: number } | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 1) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 28;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(h * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, h);
    const { major, minor } = tickSpacing(fps, px);
    const startF = Math.floor(scrollLeft / px / minor) * minor;
    const endF = (scrollLeft + width) / px;
    ctx.font = '10.5px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let f = startF; f <= endF; f += minor) {
      const x = Math.round(f * px - scrollLeft) + 0.5;
      const isMajor = Math.abs(f / major - Math.round(f / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? '#4a4a52' : '#26262b';
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, isMajor ? h - 11 : h - 5);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#8a8a93';
        ctx.fillText(label(Math.round(f), fps, major < fps), x + 4, 4);
      }
    }
  }, [px, scrollLeft, width, fps]);

  const frameAt = (clientX: number) => (clientX - rulerRef.current!.getBoundingClientRect().left) / px;

  const scrubTo = (clientX: number) => {
    let f = Math.max(0, frameAt(clientX));
    if (useUi.getState().snapping) {
      const s = snapFrame(snapTargets(getTimeline()), f, 6 / px);
      if (s != null) f = s;
    }
    seekProgram(Math.round(f));
  };

  const gaps = blackGaps(tl);
  const inF = tl.inPoint;
  const outF = tl.outPoint;

  return (
    <div
      ref={rulerRef}
      className="tl-ruler"
      data-testid="ruler"
      data-tip="Click or drag to move the playhead"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        programEngine()?.isPlaying && programEngine()!.pause();
        e.currentTarget.setPointerCapture(e.pointerId);
        useUi.getState().set({ focus: 'timeline' });
        scrubTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e.clientX);
      }}
    >
      <canvas ref={canvasRef} />
      {gaps.map((g) => (
        <div key={`g${g.start}`} className="ruler-gap" style={{ left: g.start * px, width: (g.end - g.start) * px }} />
      ))}
      {(inF != null || outF != null) && (
        <div
          className={`ruler-inout${inF == null ? ' open-start' : ''}${outF == null ? ' open-end' : ''}`}
          style={{ left: (inF ?? 0) * px, width: Math.max(2, ((outF != null ? outF + 1 : Math.max((inF ?? 0) + 1, scrollLeft / px + width / px)) - (inF ?? 0)) * px) }}
        />
      )}
      {tl.markers.map((m) => {
        const frame = dragMarker?.id === m.id ? dragMarker.frame : m.frame;
        return (
          <div
            key={m.id}
            className={`marker${selectedMarker === m.id ? ' selected' : ''}`}
            style={{ left: frame * px, ['--marker-color' as string]: MARKER_HEX[m.color] }}
            data-tip={m.label ? `${m.label} — drag to move, Delete to remove` : 'Marker — drag to move, Delete to remove'}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button !== 0) return;
              useUi.getState().select({ markerId: m.id });
              useUi.getState().set({ focus: 'timeline', inspectorTab: 'properties' });
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragMarker({ id: m.id, frame: m.frame });
              seekProgram(m.frame);
            }}
            onPointerMove={(e) => {
              if (!dragMarker || dragMarker.id !== m.id || e.buttons !== 1) return;
              const f = Math.max(0, Math.round(frameAt(e.clientX)));
              if (f !== dragMarker.frame) setDragMarker({ id: m.id, frame: f });
            }}
            onPointerUp={() => {
              if (dragMarker && dragMarker.id === m.id && dragMarker.frame !== m.frame) {
                useProject.getState().commitTimeline('Move marker', updateMarker(getTimeline(), m.id, { frame: dragMarker.frame }));
                seekProgram(dragMarker.frame);
              }
              setDragMarker(null);
            }}
          >
            {m.label && px * 30 > 40 && <span className="marker-label">{m.label}</span>}
          </div>
        );
      })}
      <PlayheadHead px={px} />
    </div>
  );
});

function PlayheadHead({ px }: { px: number }) {
  const frame = usePlayhead((s) => s.frame);
  return <div className="playhead-head" style={{ left: frame * px }} />;
}

export function PlayheadLine({ px, offset }: { px: number; offset: number }) {
  const frame = usePlayhead((s) => s.frame);
  return <div className="playhead-line" style={{ left: offset + frame * px }} data-frame={frame} />;
}

export { getPlayhead };
