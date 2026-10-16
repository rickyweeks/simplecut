import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, MonitorPlay, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { FORMATS, formatTimecode, markedRange, timelineDuration } from '@simplecut/core';
import * as edit from '../actions/edit';
import { api } from '../lib/api';
import { ProgramEngine, programEngine, setProgramEngine, type EngineHost } from '../playback/engine';
import { playableUrl, proxyPending, reportUnplayable, useAssets } from '../state/assets';
import { usePlayhead } from '../state/playhead';
import { useProject } from '../state/project';
import { useUi } from '../state/ui';
import { IconButton } from './common';

export function ProgramMonitor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poolRef = useRef<HTMLDivElement>(null);
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
      offline: (id) => !!useAssets.getState().offline[id],
      preparing: (m) => proxyPending(m, useAssets.getState().byPath[m.path]),
      scale: () => useUi.getState().prefs.playbackScale,
      unplayable: (m, url) => {
        // Only the original can be "unplayable"; a broken proxy is a different problem.
        if (url === api.mediaUrl(m.path)) reportUnplayable(m);
      },
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
      <div className="monitor-stage" onDoubleClick={() => e()?.toggle()}>
        <canvas ref={canvasRef} data-testid="program-canvas" />
        <div ref={poolRef} className="media-pool" aria-hidden />
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
