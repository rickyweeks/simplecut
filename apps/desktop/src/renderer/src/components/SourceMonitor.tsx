import { useCallback, useEffect, useRef } from 'react';
import {
  ArrowDownToLine,
  AudioLines,
  BetweenHorizontalStart,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Film,
  Pause,
  Play,
  SquareDashedBottom,
} from 'lucide-react';
import { effectiveFps, formatTimecode, mediaFrameCount, type MediaItem } from '@simplecut/core';
import { placeFromSource } from '../actions/edit';
import { beginDrag, endDrag } from '../lib/api';
import { sourcePlayer } from '../playback/source';
import { playableUrl, proxyPending, reportUnplayable, useAssets } from '../state/assets';
import { useProject } from '../state/project';
import { useSource } from '../state/source';
import { useUi } from '../state/ui';
import { IconButton } from './common';
import { WaveformCanvas } from './timeline/Waveform';

export function SourceMonitor() {
  const mediaId = useSource((s) => s.mediaId);
  const media = useProject((s) => (mediaId ? s.doc.media[mediaId] : undefined));
  const focused = useUi((s) => s.focus === 'source');

  return (
    <section className={`panel${focused ? ' focused' : ''}`} onPointerDown={() => useUi.getState().set({ focus: 'source' })} data-testid="source-monitor">
      <div className="panel-header">
        <span className="panel-title">Source</span>
        <span className="panel-subtitle">{media ? media.name : ''}</span>
        <div className="grow" />
        <SourceToggles disabled={!media} media={media} />
      </div>
      {media ? <SourceView media={media} /> : <EmptySource />}
    </section>
  );
}

function EmptySource() {
  return (
    <>
      <div className="monitor-stage">
        <div className="empty">
          <div>
            <Clapperboard className="empty-icon" size={28} />
            <h3>Preview a clip here</h3>
            Double-click a clip in the Media bin, press <kbd>I</kbd> and <kbd>O</kbd> to mark the part you want, then <kbd>,</kbd> to insert it.
          </div>
        </div>
      </div>
      <div className="monitor-bar" />
    </>
  );
}

function SourceToggles({ disabled, media }: { disabled: boolean; media?: MediaItem }) {
  const video = useSource((s) => s.video);
  const audio = useSource((s) => s.audio);
  const set = useSource((s) => s.set);
  return (
    <>
      <button
        type="button"
        className={`src-toggle v${video ? ' on' : ''}`}
        disabled={disabled || !media?.hasVideo}
        onClick={() => set({ video: !video })}
        data-tip={video ? 'Video is on: insert/overwrite brings in the picture' : 'Video is off: only sound will be placed'}
        aria-pressed={video}
      >
        V
      </button>
      <button
        type="button"
        className={`src-toggle a${audio ? ' on' : ''}`}
        disabled={disabled || !media?.hasAudio}
        onClick={() => set({ audio: !audio })}
        data-tip={audio ? 'Audio is on: insert/overwrite brings in the sound' : 'Audio is off: only the picture will be placed'}
        aria-pressed={audio}
      >
        A
      </button>
    </>
  );
}

function SourceView({ media }: { media: MediaItem }) {
  const assets = useAssets((s) => s.byPath[media.path]);
  const offline = useAssets((s) => !!s.offline[media.id]);
  const url = playableUrl(media, assets);
  const playing = useSource((s) => s.playing);
  const s = useSource();
  const tlFps = useProject((st) => effectiveFps(st.doc.timeline, media));
  const fps = tlFps;
  const frame = Math.floor(s.timeSec * fps + 1e-6);
  const total = media.kind === 'image' ? 0 : mediaFrameCount(media, fps);
  const inF = s.inSec != null ? Math.round(s.inSec * fps) : null;
  const outF = s.outSec != null ? Math.round(s.outSec * fps) : null; // exclusive
  const markedFrames = media.kind === 'image' ? 5 * fps : (outF ?? total) - (inF ?? 0);

  const attach = useCallback((el: HTMLMediaElement | null) => sourcePlayer.attach(el), []);
  useEffect(() => () => sourcePlayer.attach(null), []);

  const dragPayload = (video: boolean, audio: boolean) => ({ mediaId: media.id, inSec: s.inSec ?? 0, outSec: s.outSec, video, audio });
  const preparing = !offline && !url && proxyPending(media, assets);

  return (
    <>
      <div
        className="monitor-stage"
        draggable={!offline}
        onDragStart={(e) => beginDrag(e, dragPayload(s.video, s.audio))}
        onDragEnd={endDrag}
        data-tip="Drag to the timeline to place the marked range"
      >
        {offline ? (
          <div className="monitor-overlay">Media offline — relink it to preview</div>
        ) : media.kind === 'image' ? (
          url && <img className="still" src={url} alt="" draggable={false} />
        ) : media.kind === 'audio' ? (
          <>
            {url && <audio key={url} ref={attach} src={url} preload="auto" onError={() => reportUnplayable(media)} />}
            <div className="audio-only-stage">
              <AudioLines size={40} color="var(--audio-edge)" strokeWidth={1.25} />
            </div>
          </>
        ) : (
          url && <video key={url} ref={attach} src={url} preload="auto" playsInline onError={() => reportUnplayable(media)} />
        )}
        {preparing && <div className="monitor-overlay">Preparing preview… {Math.round((assets?.proxy?.progress ?? 0) * 100)}%</div>}
      </div>
      {media.kind !== 'image' && (
        <Scrubber media={media} frame={frame} total={total} inF={inF} outF={outF} waveform={media.kind === 'audio' ? assets?.waveform : undefined} />
      )}
      <div className="monitor-bar">
        <span className="tc" data-testid="source-tc">
          {formatTimecode(frame, fps)}
        </span>
        <div className="grow" />
        <IconButton icon={<SquareDashedBottom size={16} style={{ transform: 'scaleX(-1)' }} />} label="Mark In" kbd="I" onClick={() => sourcePlayer.markIn()} disabled={media.kind === 'image'} small />
        <IconButton icon={<SquareDashedBottom size={16} />} label="Mark Out" kbd="O" onClick={() => sourcePlayer.markOut()} disabled={media.kind === 'image'} small />
        <IconButton icon={<ChevronLeft size={17} />} label="Step back one frame" kbd="←" onClick={() => sourcePlayer.step(-1)} small />
        <IconButton icon={playing ? <Pause size={17} /> : <Play size={17} />} label={playing ? 'Pause' : 'Play'} kbd="Space / L" onClick={() => sourcePlayer.toggle()} disabled={media.kind === 'image'} />
        <IconButton icon={<ChevronRight size={17} />} label="Step forward one frame" kbd="→" onClick={() => sourcePlayer.step(1)} small />
        <div className="topbar-sep" />
        <IconButton icon={<BetweenHorizontalStart size={16} />} label="Insert at playhead (pushes clips later)" kbd="," onClick={() => placeFromSource('insert')} small testId="insert" />
        <IconButton icon={<ArrowDownToLine size={16} />} label="Overwrite at playhead" kbd="." onClick={() => placeFromSource('overwrite')} small testId="overwrite" />
        <div className="topbar-sep" />
        <div
          className="icon-btn small drag-handle"
          draggable={media.hasVideo && !offline}
          onDragStart={(e) => beginDrag(e, dragPayload(true, false))}
          onDragEnd={endDrag}
          data-tip="Drag video only"
          aria-label="Drag video only"
          style={{ opacity: media.hasVideo ? 1 : 0.3 }}
        >
          <Film size={16} />
        </div>
        <div
          className="icon-btn small drag-handle"
          draggable={media.hasAudio && !offline}
          onDragStart={(e) => beginDrag(e, dragPayload(false, true))}
          onDragEnd={endDrag}
          data-tip="Drag audio only"
          aria-label="Drag audio only"
          style={{ opacity: media.hasAudio ? 1 : 0.3 }}
        >
          <AudioLines size={16} />
        </div>
        <span className="tc dim" data-tip="Length of the marked range">
          {formatTimecode(Math.max(0, markedFrames), fps)}
        </span>
      </div>
    </>
  );
}

function Scrubber({ media, frame, total, inF, outF, waveform }: { media: MediaItem; frame: number; total: number; inF: number | null; outF: number | null; waveform?: Uint8Array }) {
  const ref = useRef<HTMLDivElement>(null);
  const seekTo = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    sourcePlayer.seekFrame(Math.round(t * Math.max(0, total - 1)));
  };
  const pct = (f: number) => `${(f / Math.max(1, total)) * 100}%`;
  return (
    <div
      ref={ref}
      className="scrubber"
      onPointerDown={(e) => {
        if (sourcePlayer.playing) sourcePlayer.pause();
        e.currentTarget.setPointerCapture(e.pointerId);
        seekTo(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && seekTo(e.clientX)}
      data-testid="source-scrubber"
    >
      {waveform && (
        <WaveformCanvas peaks={waveform} startSec={0} durationSec={media.durationSec} height={22} color="rgba(79,224,164,0.45)" style={{ position: 'absolute', inset: 0 }} />
      )}
      <div className="scrubber-track" />
      {(inF != null || outF != null) && (
        <div className="scrubber-range" style={{ left: pct(inF ?? 0), width: pct((outF ?? total) - (inF ?? 0)) }} />
      )}
      <div className="scrubber-head" style={{ left: pct(frame) }} />
    </div>
  );
}
