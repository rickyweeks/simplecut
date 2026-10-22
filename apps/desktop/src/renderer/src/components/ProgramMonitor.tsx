import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, MonitorPlay, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { FORMATS, clipAt, formatTimecode, markedRange, timelineDuration, updateClips, videoTracks, type Clip } from '@simplecut/core';
import * as edit from '../actions/edit';
import { addTitleAt } from '../actions/titles';
import { api } from '../lib/api';
import { ProgramEngine, programEngine, setProgramEngine, type EngineHost } from '../playback/engine';
import { audioUrlFor, playableUrl, proxyPending, reportUnplayable, useAssets } from '../state/assets';
import { duckRegionsFor } from '../state/ducking';
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
    };
    const engine = new ProgramEngine(canvasRef.current!, poolRef.current!, host);
    setProgramEngine(engine);
    const invalidate = () => engine.invalidate();
    const unsubs = [
      useProject.subscribe(invalidate),
      useAssets.subscribe(invalidate),
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
        <TitleOverlay stageRef={stageRef} />
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
        <div className="grow" />
        <span className="tc dim" data-tip={marked ? 'Length of the In–Out range' : 'Length of the timeline'}>
          {formatTimecode(marked ? marked.end - marked.start : timelineDuration(tl), fps)}
        </span>
      </div>
    </section>
  );
}

/**
 * Titles can be selected and dragged right on the picture; the T tool places a new title
 * where you click. Positions are fractions of the frame, so they survive format changes.
 */
function TitleOverlay({ stageRef }: { stageRef: React.RefObject<HTMLDivElement | null> }) {
  const committed = useProject((s) => s.doc.timeline);
  const preview = useUi((s) => s.preview);
  const tl = preview ?? committed;
  const frame = usePlayhead((s) => s.frame);
  const tool = useUi((s) => s.tool);
  const selected = useUi((s) => s.selection.clipIds);
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [guide, setGuide] = useState(false);
  const drag = useRef<{ clip: Clip; startX: number; startY: number; x0: number; y0: number; moved: boolean } | null>(null);
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

  // Titles visible at the playhead, top track first (that's what a click hits).
  const titles: Clip[] = [];
  for (const t of [...videoTracks(tl)].reverse()) {
    if (t.hidden) continue;
    const c = clipAt(tl, t.id, frame);
    if (c?.text) titles.push(c);
  }
  const k = rect.width / W;
  const boxOf = (c: Clip) => {
    const b = renderText(c.text!, W, H).bounds;
    return { left: b.x * k, top: b.y * k, width: b.w * k, height: b.h * k };
  };
  const toFrame = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - rect.left) / rect.width, y: (clientY - r.top - rect.top) / rect.height };
  };

  return (
    <div
      ref={self}
      className={`title-overlay${tool === 'text' ? ' text-tool' : ''}`}
      style={rect}
      data-tip={tool === 'text' ? 'Click to add a title here' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const ui = useUi.getState();
        if (ui.tool === 'text') {
          const p = toFrame(e.clientX, e.clientY);
          addTitleAt(p.x, p.y);
          return;
        }
        const hit = titles.find((c) => {
          const b = boxOf(c);
          const x = e.clientX - (e.currentTarget.getBoundingClientRect().left);
          const y = e.clientY - (e.currentTarget.getBoundingClientRect().top);
          return x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;
        });
        if (!hit) return;
        e.stopPropagation();
        ui.select({ clipIds: [hit.id] });
        ui.set({ inspectorTab: 'properties' });
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { clip: hit, startX: e.clientX, startY: e.clientY, x0: hit.text!.x, y0: hit.text!.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.startX) / rect.width;
        const dy = (e.clientY - d.startY) / rect.height;
        if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 3) return;
        d.moved = true;
        let x = Math.min(1, Math.max(0, d.x0 + dx));
        const y = Math.min(1, Math.max(0, d.y0 + dy));
        // Snap to the horizontal center.
        const snapped = Math.abs(x - 0.5) * rect.width < 8;
        if (snapped) x = 0.5;
        setGuide(snapped);
        const base = getTimeline();
        useUi.getState().set({ preview: updateClips(base, [d.clip.id], { text: { ...d.clip.text!, x, y } }) });
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setGuide(false);
        const result = useUi.getState().preview;
        useUi.getState().set({ preview: null });
        if (d?.moved && result) useProject.getState().commitTimeline('Move title', result);
      }}
      onDoubleClick={() => {
        if (titles.some((c) => selected.includes(c.id))) window.dispatchEvent(new Event('scut:edit-title'));
      }}
    >
      {titles
        .filter((c) => selected.includes(c.id))
        .map((c) => (
          <div key={c.id} className="title-box" style={boxOf(c)} />
        ))}
      {guide && <div className="title-guide" />}
    </div>
  );
}
