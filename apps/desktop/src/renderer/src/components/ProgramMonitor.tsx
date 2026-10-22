import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, MonitorPlay, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import {
  FORMATS,
  clipAt,
  formatTimecode,
  markedRange,
  mediaPictureSize,
  pictureGeometry,
  timelineDuration,
  transformOf,
  updateClips,
  updateTransforms,
  videoTracks,
  zoomScaleAt,
  type Clip,
  type PictureGeometry,
  type Transform,
} from '@simplecut/core';
import * as edit from '../actions/edit';
import { exportFrameCmd } from '../actions/deliver';
import { addTitleAt } from '../actions/titles';
import { api } from '../lib/api';
import { ProgramEngine, programEngine, setProgramEngine, type EngineHost } from '../playback/engine';
import { visibleRect } from '../render/picture';
import { audioUrlFor, playableUrl, proxyPending, reportUnplayable, useAssets } from '../state/assets';
import { duckRegionsFor } from '../state/ducking';
import { inputLut, useLuts } from '../state/luts';
import { usePlayhead } from '../state/playhead';
import { getTimeline, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { renderText } from '../text/renderText';
import { IconButton } from './common';

export function ProgramMonitor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poolRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const focused = useUi((s) => s.focus === 'program');
  const scale = useUi((s) => s.prefs.playbackScale);
  const setPrefs = useUi((s) => s.setPrefs);
  const tl = useProject((s) => s.doc.timeline);
  const playing = usePlayhead((s) => s.playing);
  const rate = usePlayhead((s) => s.rate);
  const frame = usePlayhead((s) => s.frame);
  const fps = tl.settings.fps;
  const { width, height } = FORMATS[tl.settings.format];
  const hasClips = Object.keys(tl.clips).length > 0;
  const marked = markedRange(tl);

  useEffect(() => {
    const host: EngineHost = {
      timeline: () => useUi.getState().preview ?? useProject.getState().doc.timeline,
      media: (id) => useProject.getState().doc.media[id],
      url: (m) => playableUrl(m, useAssets.getState().byPath[m.path]),
      audioUrl: (c, m) => audioUrlFor(c, m, useAssets.getState().byPath[m.path]),
      offline: (id) => !!useAssets.getState().offline[id],
      preparing: (m) => proxyPending(m, useAssets.getState().byPath[m.path]),
      scale: () => useUi.getState().prefs.playbackScale,
      unplayable: (m, url) => {
        // Only the original can be "unplayable"; a broken proxy is a different problem.
        if (url === api.mediaUrl(m.path)) reportUnplayable(m);
      },
      text: renderText,
      duckRegions: () => duckRegionsFor(useProject.getState().doc.timeline),
      inputLut,
    };
    const engine = new ProgramEngine(canvasRef.current!, poolRef.current!, host);
    setProgramEngine(engine);
    const invalidate = () => engine.invalidate();
    const unsubs = [
      useProject.subscribe(invalidate),
      useAssets.subscribe(invalidate),
      useLuts.subscribe(invalidate),
      useUi.subscribe((s, prev) => {
        if (s.preview !== prev.preview || s.prefs.playbackScale !== prev.prefs.playbackScale) invalidate();
      }),
    ];
    return () => {
      unsubs.forEach((u) => u());
      engine.dispose();
      setProgramEngine(null);
    };
  }, []);

  const e = () => programEngine();

  return (
    <section className={`panel${focused ? ' focused' : ''}`} onPointerDown={() => useUi.getState().set({ focus: 'program' })} data-testid="program-monitor">
      <div className="panel-header">
        <span className="panel-title">Program</span>
        <span className="panel-subtitle">
          {width}×{height} · {fps} fps
        </span>
        <div className="grow" />
        <div className="seg" data-tip="Playback resolution — lower it if playback stutters on a slower PC">
          {([1, 0.5, 0.25] as const).map((s) => (
            <button key={s} type="button" className={scale === s ? 'on' : ''} onClick={() => setPrefs({ playbackScale: s })}>
              {s === 1 ? 'Full' : s === 0.5 ? '½' : '¼'}
            </button>
          ))}
        </div>
      </div>
      <div className="monitor-stage" ref={stageRef}>
        <canvas ref={canvasRef} data-testid="program-canvas" />
        <div ref={poolRef} className="media-pool" aria-hidden />
        <PictureOverlay stageRef={stageRef} />
        {!hasClips && (
          <div className="empty">
            <div>
              <MonitorPlay className="empty-icon" size={28} />
              <h3>Your edit plays here</h3>
              Add clips to the timeline, then press <kbd>Space</kbd> to play.
            </div>
          </div>
        )}
      </div>
      <div className="monitor-bar">
        <span className="tc">{formatTimecode(frame, fps)}</span>
        {playing && rate !== 1 && <span className="rate-badge">{rate > 0 ? `${rate}×` : `◀ ${-rate}×`}</span>}
        <div className="grow" />
        <IconButton icon={<span style={{ font: '700 15px var(--mono)' }}>{'{'}</span>} label="Mark In" kbd="I" onClick={() => edit.markTimeline('in')} small />
        <IconButton icon={<span style={{ font: '700 15px var(--mono)' }}>{'}'}</span>} label="Mark Out" kbd="O" onClick={() => edit.markTimeline('out')} small />
        <IconButton icon={<SkipBack size={16} />} label="Previous edit point" kbd="↑" onClick={() => edit.goToEdit(-1)} small />
        <IconButton icon={<ChevronLeft size={17} />} label="Step back one frame" kbd="←" onClick={() => e()?.step(-1)} small />
        <IconButton icon={playing ? <Pause size={17} /> : <Play size={17} />} label={playing ? 'Pause' : 'Play'} kbd="Space / L" onClick={() => e()?.toggle()} testId="program-play" />
        <IconButton icon={<ChevronRight size={17} />} label="Step forward one frame" kbd="→" onClick={() => e()?.step(1)} small />
        <IconButton icon={<SkipForward size={16} />} label="Next edit point" kbd="↓" onClick={() => edit.goToEdit(1)} small />
        <IconButton icon={<Camera size={16} />} label="Save this frame as a thumbnail (PNG)" kbd="Ctrl+Shift+E" onClick={() => void exportFrameCmd()} small testId="export-frame" />
        <div className="grow" />
        <span className="tc dim" data-tip={marked ? 'Length of the In–Out range' : 'Length of the timeline'}>
          {formatTimecode(marked ? marked.end - marked.start : timelineDuration(tl), fps)}
        </span>
      </div>
    </section>
  );
}

type Drag =
  | { mode: 'title'; clip: Clip; startX: number; startY: number; x0: number; y0: number; moved: boolean }
  | { mode: 'move'; clip: Clip; startX: number; startY: number; t0: Transform; moved: boolean }
  | { mode: 'scale'; clip: Clip; cx: number; cy: number; d0: number; t0: Transform; moved: boolean }
  | { mode: 'rotate'; clip: Clip; cx: number; cy: number; a0: number; t0: Transform; moved: boolean };

/**
 * Direct manipulation on the picture. Titles: click and drag to move (the T tool adds one
 * where you click). Clips: click to select, then drag to move, drag a corner to scale and
 * the round knob to rotate (holding Shift turns snapping off). Positions are fractions of
 * the frame, so they survive format changes.
 */
function PictureOverlay({ stageRef }: { stageRef: React.RefObject<HTMLDivElement | null> }) {
  const committed = useProject((s) => s.doc.timeline);
  const media = useProject((s) => s.doc.media);
  const preview = useUi((s) => s.preview);
  const tl = preview ?? committed;
  const frame = usePlayhead((s) => s.frame);
  const tool = useUi((s) => s.tool);
  const selected = useUi((s) => s.selection.clipIds);
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const drag = useRef<Drag | null>(null);
  const self = useRef<HTMLDivElement>(null);
  const { width: W, height: H } = FORMATS[tl.settings.format];

  // Where the picture actually is inside the stage (object-fit: contain). The stage's own ref
  // isn't attached yet when a child's layout effect runs, so measure through our parent.
  useLayoutEffect(() => {
    const el = self.current?.parentElement;
    if (!el) return;
    const update = () => {
      const sw = el.clientWidth;
      const sh = el.clientHeight;
      const s = Math.min(sw / W, sh / H);
      setRect({ width: W * s, height: H * s, left: (sw - W * s) / 2, top: (sh - H * s) / 2 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // What is visible at the playhead, top track first (that's what a click hits).
  const titles: Clip[] = [];
  const pictures: { clip: Clip; g: PictureGeometry }[] = [];
  for (const t of [...videoTracks(tl)].reverse()) {
    if (t.hidden) continue;
    const c = clipAt(tl, t.id, frame);
    if (!c) continue;
    if (c.text) titles.push(c);
    else if (media[c.mediaId]) {
      const { w, h } = mediaPictureSize(media[c.mediaId]!);
      const tr = transformOf(c);
      pictures.push({ clip: c, g: pictureGeometry(tr, w, h, W, H, zoomScaleAt(tr, frame - c.start, c.duration)) });
    }
  }
  const k = rect.width / W;
  const titleBox = (c: Clip) => {
    const b = renderText(c.text!, W, H).bounds;
    return { left: b.x * k, top: b.y * k, width: b.w * k, height: b.h * k };
  };
  const local = (clientX: number, clientY: number) => {
    const r = self.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  /** Is an overlay point inside a picture's visible (rotated) rectangle? */
  const hits = (g: PictureGeometry, x: number, y: number) => {
    const a = (-g.rotation * Math.PI) / 180;
    const dx = x / k - g.cx;
    const dy = y / k - g.cy;
    const rx = dx * Math.cos(a) - dy * Math.sin(a);
    const ry = dx * Math.sin(a) + dy * Math.cos(a);
    const v = visibleRect(g);
    return rx >= v.x && rx <= v.x + v.w && ry >= v.y && ry <= v.y + v.h;
  };
  const selectedPicture = pictures.find((p) => selected.includes(p.clip.id));

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    self.current!.setPointerCapture(e.pointerId);
    drag.current = d;
  };
  const startHandle = (e: React.PointerEvent, mode: 'scale' | 'rotate') => {
    if (e.button !== 0 || !selectedPicture) return;
    const { clip, g } = selectedPicture;
    const p = local(e.clientX, e.clientY);
    const cx = g.cx * k;
    const cy = g.cy * k;
    const t0 = transformOf(clip);
    if (mode === 'scale') begin(e, { mode, clip, cx, cy, d0: Math.hypot(p.x - cx, p.y - cy) || 1, t0, moved: false });
    else begin(e, { mode, clip, cx, cy, a0: Math.atan2(p.y - cy, p.x - cx), t0, moved: false });
  };

  const box = selectedPicture?.g;

  return (
    <div
      ref={self}
      className={`title-overlay${tool === 'text' ? ' text-tool' : ''}`}
      style={rect}
      data-testid="picture-overlay"
      data-tip={tool === 'text' ? 'Click to add a title here' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const ui = useUi.getState();
        const p = local(e.clientX, e.clientY);
        if (ui.tool === 'text') {
          addTitleAt(p.x / rect.width, p.y / rect.height);
          return;
        }
        const title = titles.find((c) => {
          const b = titleBox(c);
          return p.x >= b.left && p.x <= b.left + b.width && p.y >= b.top && p.y <= b.top + b.height;
        });
        if (title) {
          ui.select({ clipIds: [title.id] });
          ui.set({ inspectorTab: 'properties' });
          begin(e, { mode: 'title', clip: title, startX: e.clientX, startY: e.clientY, x0: title.text!.x, y0: title.text!.y, moved: false });
          return;
        }
        const hit = pictures.find((pic) => hits(pic.g, p.x, p.y));
        if (!hit) return;
        if (!selected.includes(hit.clip.id)) {
          // First click selects; dragging needs a selected clip so the main footage never moves by accident.
          e.stopPropagation();
          ui.select({ clipIds: [hit.clip.id] });
          ui.set({ inspectorTab: 'properties' });
          return;
        }
        begin(e, { mode: 'move', clip: hit.clip, startX: e.clientX, startY: e.clientY, t0: transformOf(hit.clip), moved: false });
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && 'startX' in d && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 3) return;
        d.moved = true;
        const base = getTimeline();
        const snap = !e.shiftKey;
        if (d.mode === 'title') {
          let x = Math.min(1, Math.max(0, d.x0 + (e.clientX - d.startX) / rect.width));
          const y = Math.min(1, Math.max(0, d.y0 + (e.clientY - d.startY) / rect.height));
          const v = snap && Math.abs(x - 0.5) * rect.width < 8;
          if (v) x = 0.5;
          setGuides({ v, h: false });
          useUi.getState().set({ preview: updateClips(base, [d.clip.id], { text: { ...d.clip.text!, x, y } }) });
          return;
        }
        let patch: Partial<Transform>;
        if (d.mode === 'move') {
          let x = d.t0.x + (e.clientX - d.startX) / rect.width;
          let y = d.t0.y + (e.clientY - d.startY) / rect.height;
          const v = snap && Math.abs(x - 0.5) * rect.width < 8;
          const h = snap && Math.abs(y - 0.5) * rect.height < 8;
          if (v) x = 0.5;
          if (h) y = 0.5;
          setGuides({ v, h });
          patch = { x, y };
        } else if (d.mode === 'scale') {
          const p = local(e.clientX, e.clientY);
          let s = Math.max(0.05, Math.min(8, d.t0.scale * (Math.hypot(p.x - d.cx, p.y - d.cy) / d.d0)));
          if (snap && Math.abs(s - 1) < 0.03) s = 1;
          patch = { scale: Math.round(s * 1000) / 1000, ...(d.t0.zoomTo != null ? { zoomTo: Math.round(d.t0.zoomTo * (s / d.t0.scale) * 1000) / 1000 } : {}) };
        } else {
          const p = local(e.clientX, e.clientY);
          let r = d.t0.rotation + ((Math.atan2(p.y - d.cy, p.x - d.cx) - d.a0) * 180) / Math.PI;
          r = ((((r + 180) % 360) + 360) % 360) - 180;
          if (snap) {
            const q = Math.round(r / 90) * 90;
            if (Math.abs(r - q) < 4) r = q;
          }
          patch = { rotation: Math.round(r * 10) / 10 };
        }
        useUi.getState().set({ preview: updateTransforms(base, [d.clip.id], patch) });
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setGuides({ v: false, h: false });
        const result = useUi.getState().preview;
        useUi.getState().set({ preview: null });
        if (!d?.moved || !result) return;
        const label = d.mode === 'title' ? 'Move title' : d.mode === 'move' ? 'Move clip' : d.mode === 'scale' ? 'Scale clip' : 'Rotate clip';
        useProject.getState().commitTimeline(label, result);
      }}
      onDoubleClick={() => {
        if (titles.some((c) => selected.includes(c.id))) window.dispatchEvent(new Event('scut:edit-title'));
      }}
    >
      {titles
        .filter((c) => selected.includes(c.id))
        .map((c) => (
          <div key={c.id} className="title-box" style={titleBox(c)} />
        ))}
      {box && selectedPicture && (
        <div
          className="pic-box"
          data-testid="pic-box"
          style={{
            left: (box.cx + visibleRect(box).x) * k,
            top: (box.cy + visibleRect(box).y) * k,
            width: box.cw * k,
            height: box.ch * k,
            transformOrigin: `${(-visibleRect(box).x) * k}px ${(-visibleRect(box).y) * k}px`,
            transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
          }}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span key={corner} className={`pic-handle ${corner}`} data-testid={`pic-handle-${corner}`} onPointerDown={(e) => startHandle(e, 'scale')} />
          ))}
          <span className="pic-rotate" data-testid="pic-rotate" data-tip="Drag to rotate (Shift: no snapping)" onPointerDown={(e) => startHandle(e, 'rotate')} />
        </div>
      )}
      {guides.v && <div className="title-guide" />}
      {guides.h && <div className="title-guide h" />}
    </div>
  );
}
