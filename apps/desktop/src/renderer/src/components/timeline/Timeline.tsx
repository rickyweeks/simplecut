import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  Bookmark,
  FoldHorizontal,
  Group,
  Link,
  Magnet,
  Maximize2,
  MousePointer2,
  Plus,
  Scissors,
  SquareSplitHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  FORMATS,
  addTrack,
  audioTracks,
  blackGaps,
  clipEnd,
  clipsOnTrack,
  defaultIds,
  edgeClips,
  expandSelection,
  formatTimecode,
  gapAt,
  isLinked,
  isTrackAudible,
  isTrackLocked,
  moveClips,
  snapEdges,
  snapFrame,
  snapTargets,
  timelineDuration,
  trackIndex,
  trackLabel,
  trimClips,
  videoTracks,
  type Clip,
  type Edge,
  type PlacementTracks,
  type Range,
  type Timeline as TimelineModel,
  type Track,
} from '@simplecut/core';
import * as edit from '../../actions/edit';
import { importPaths } from '../../actions/project';
import { DRAG_MIME, activeDrag, endDrag, type DragSource } from '../../lib/api';
import { useAssets } from '../../state/assets';
import { getPlayhead, usePlayhead } from '../../state/playhead';
import { getDoc, getTimeline, useProject } from '../../state/project';
import { useSource } from '../../state/source';
import { MAX_PX_PER_FRAME, MIN_PX_PER_FRAME, useUi } from '../../state/ui';
import { IconButton } from '../common';
import { isOsFileDrag, osFilePaths } from '../MediaBin';
import { ClipView } from './ClipView';
import { PlayheadLine, Ruler } from './Ruler';
import { TrackHeader } from './TrackHeader';

const HEADER_W = 156;
const RULER_H = 28;
const ROW_H = { video: 64, audio: 56 } as const;
const DIVIDER_H = 6;
const SNAP_PX = 8;

interface Row {
  track: Track;
  index: number;
  top: number;
  height: number;
}

type Drag =
  | { kind: 'move'; startX: number; startY: number; ids: string[]; base: TimelineModel; anchor: Clip; anchorIdx: number; dup: boolean; started: boolean; dt: number }
  | { kind: 'trim'; startX: number; ids: string[]; edge: Edge; base: TimelineModel; started: boolean; ripple: boolean }
  | { kind: 'marquee'; startX: number; startY: number; base: TimelineModel; initial: string[]; started: boolean };

export function Timeline() {
  const committed = useProject((s) => s.doc.timeline);
  const preview = useUi((s) => s.preview);
  const tl = preview ?? committed;
  const media = useProject((s) => s.doc.media);
  const px = useUi((s) => s.pxPerFrame);
  const tool = useUi((s) => s.tool);
  const snapping = useUi((s) => s.snapping);
  const selection = useUi((s) => s.selection);
  const snapAt = useUi((s) => s.snapAt);
  const focused = useUi((s) => s.focus === 'timeline');
  const offline = useAssets((s) => s.offline);
  const assets = useAssets((s) => s.byPath);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const dropKey = useRef('');
  const pendingScroll = useRef<number | null>(null);
  const pxRef = useRef(px);
  pxRef.current = px;
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [razorAt, setRazorAt] = useState<number | null>(null);
  const [readout, setReadout] = useState<{ x: number; y: number; text: string } | null>(null);

  const fps = tl.settings.fps;
  const duration = timelineDuration(tl);
  const laneWidth = Math.max(0, view.width - HEADER_W);
  const contentFrames = Math.max(duration + fps * 30, laneWidth / px + 1);
  const contentWidth = HEADER_W + contentFrames * px;
  const viewFrom = view.left / px - 20 / px;
  const viewTo = (view.left + laneWidth) / px + 20 / px;

  // Rows: highest video track on top, then the divider, then A1, A2, ...
  const rows = useMemo(() => {
    const out: { video: Row[]; audio: Row[]; dividerTop: number; bottom: number } = { video: [], audio: [], dividerTop: 0, bottom: 0 };
    let y = RULER_H;
    const vts = videoTracks(tl);
    for (let i = vts.length - 1; i >= 0; i--) {
      out.video.push({ track: vts[i]!, index: i, top: y, height: ROW_H.video });
      y += ROW_H.video + 1;
    }
    out.dividerTop = y;
    y += DIVIDER_H + 1;
    audioTracks(tl).forEach((t, i) => {
      out.audio.push({ track: t, index: i, top: y, height: ROW_H.audio });
      y += ROW_H.audio + 1;
    });
    out.bottom = y;
    return out;
  }, [tl.tracks]);
  const allRows = useMemo(() => [...rows.video, ...rows.audio], [rows]);

  // ---------------------------------------------------------------- scrolling
  useEffect(() => {
    const el = scrollRef.current!;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
    }
  }, [px]);

  /** Zooms keeping `anchorFrame` at the same screen position. */
  const zoomTo = useCallback((nextPx: number, anchorFrame?: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const cur = pxRef.current;
    const p = Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, nextPx));
    const rect = el.getBoundingClientRect();
    const frame = anchorFrame ?? getPlayhead();
    const offset = anchorClientX != null ? anchorClientX - rect.left - HEADER_W : frame * cur - el.scrollLeft;
    const visible = offset >= 0 && offset <= el.clientWidth - HEADER_W;
    pendingScroll.current = frame * p - (visible ? offset : (el.clientWidth - HEADER_W) / 2);
    useUi.getState().set({ pxPerFrame: p });
  }, []);

  useEffect(() => {
    edit.onZoomRequest((z) => {
      const el = scrollRef.current;
      if (!el) return;
      if (z === 'fit') {
        const t = getTimeline();
        const frames = Math.max(timelineDuration(t), t.settings.fps * 10);
        pendingScroll.current = 0;
        useUi.getState().set({ pxPerFrame: Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, (el.clientWidth - HEADER_W - 40) / frames)) });
      } else zoomTo(pxRef.current * (z === 'in' ? 1.5 : 1 / 1.5));
    });
    return () => edit.onZoomRequest(null);
  }, [zoomTo]);

  // Wheel: horizontal scroll; Ctrl/Alt+wheel zooms around the pointer; Shift+wheel scrolls tracks.
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.altKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const frame = (e.clientX - rect.left - HEADER_W + el.scrollLeft) / pxRef.current;
        zoomTo(pxRef.current * (e.deltaY < 0 ? 1.25 : 1 / 1.25), Math.max(0, frame), e.clientX);
      } else if (e.shiftKey) {
        e.preventDefault();
        el.scrollTop += e.deltaY;
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Keep the playhead in view: page along while playing, jump when it moves off-screen.
  useEffect(
    () =>
      usePlayhead.subscribe((s, prev) => {
        if (s.frame === prev.frame) return;
        const el = scrollRef.current;
        if (!el || dragRef.current) return;
        const x = s.frame * pxRef.current;
        const w = el.clientWidth - HEADER_W;
        if (x > el.scrollLeft + w - 24 || x < el.scrollLeft) el.scrollLeft = s.playing ? x - 24 : x - w / 2;
      }),
    [],
  );

  // ---------------------------------------------------------------- geometry
  const locate = (clientX: number, clientY: number) => {
    const rect = contentRef.current!.getBoundingClientRect();
    const frame = (clientX - rect.left - HEADER_W) / pxRef.current;
    const y = clientY - rect.top;
    const row = allRows.find((r) => y >= r.top && y < r.top + r.height + 1) ?? null;
    return { frame, row, x: clientX - rect.left, y };
  };

  const snapOne = (t: TimelineModel, frame: number, exclude: string[] = []) => {
    if (!useUi.getState().snapping) return { frame: Math.round(frame), at: null as number | null };
    const s = snapFrame(snapTargets(t, { playhead: getPlayhead(), exclude }), frame, SNAP_PX / pxRef.current);
    return s != null ? { frame: s, at: s } : { frame: Math.round(frame), at: null };
  };

  const overrideFor = (t: TimelineModel, row: Row | null): Partial<PlacementTracks> => {
    if (!row) return {};
    if (row.track.kind === 'video') return { videoTrackId: row.track.id, audioTrackId: audioTracks(t)[row.index]?.id ?? t.targetAudioTrackId };
    return { audioTrackId: row.track.id, videoTrackId: videoTracks(t)[row.index]?.id ?? t.targetVideoTrackId };
  };

  // ---------------------------------------------------------------- pointer interactions
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.track-header, .tl-ruler-row, .tl-add-row')) return;
    const ui = useUi.getState();
    ui.set({ focus: 'timeline' });
    const { frame, row } = locate(e.clientX, e.clientY);
    if (frame < 0 || !row) return;
    const base = getTimeline();
    const clipEl = target.closest('[data-clip-id]') as HTMLElement | null;
    const edgeEl = target.closest('[data-edge]') as HTMLElement | null;

    if (clipEl) {
      const clip = base.clips[clipEl.dataset.clipId!];
      if (!clip) return;
      if (isTrackLocked(base, clip.trackId)) return ui.toast(`${trackLabel(base, clip.trackId)} is locked.`);
      if (ui.tool === 'razor') {
        edit.razorAt(clip.id, snapOne(base, frame).frame, { allTracks: e.shiftKey, linkedToo: !e.altKey });
        return;
      }
      contentRef.current!.setPointerCapture(e.pointerId);
      if (edgeEl) {
        const edge = edgeEl.dataset.edge as Edge;
        const ids = edgeClips(base, clip.id, edge, !e.altKey).map((c) => c.id);
        ui.select({ clipIds: ids });
        dragRef.current = { kind: 'trim', startX: e.clientX, ids, edge, base, started: false, ripple: e.ctrlKey };
        return;
      }
      const group = expandSelection(base, [clip.id], { linked: !e.altKey });
      let sel = ui.selection.clipIds;
      if (e.shiftKey || e.ctrlKey) {
        const allIn = group.every((id) => sel.includes(id));
        sel = allIn ? sel.filter((id) => !group.includes(id)) : [...new Set([...sel, ...group])];
      } else if (!sel.includes(clip.id) || e.altKey) {
        sel = group;
      }
      ui.select({ clipIds: sel });
      if (!sel.includes(clip.id)) return;
      dragRef.current = { kind: 'move', startX: e.clientX, startY: e.clientY, ids: sel, base, anchor: clip, anchorIdx: trackIndex(base, clip.trackId), dup: e.altKey, started: false, dt: 0 };
      return;
    }

    if (ui.tool === 'razor') return;
    contentRef.current!.setPointerCapture(e.pointerId);
    const additive = e.shiftKey || e.ctrlKey;
    dragRef.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY, base, initial: additive ? ui.selection.clipIds : [], started: false };
    if (!additive) ui.select({});
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const ui = useUi.getState();
    if (!d) {
      if (ui.tool === 'razor') {
        const { frame, row } = locate(e.clientX, e.clientY);
        setRazorAt(row && frame >= 0 ? snapOne(getTimeline(), frame).frame : null);
      }
      return;
    }
    const dx = e.clientX - d.startX;
    const dy = d.kind === 'trim' ? 0 : e.clientY - d.startY;
    if (!d.started) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      d.started = true;
    }
    const pxNow = pxRef.current;
    const t = d.base;

    if (d.kind === 'move') {
      let delta = Math.round(dx / pxNow);
      const { row } = locate(e.clientX, e.clientY);
      if (row && row.track.kind === d.anchor.kind) d.dt = row.index - d.anchorIdx;
      let at: number | null = null;
      if (ui.snapping) {
        const moving = d.ids.map((id) => t.clips[id]).filter((c): c is Clip => !!c);
        const edges = moving.flatMap((c) => [c.start + delta, clipEnd(c) + delta]);
        const s = snapEdges(snapTargets(t, { playhead: getPlayhead(), exclude: d.dup ? [] : d.ids }), edges, SNAP_PX / pxNow);
        if (s) {
          delta += s.correction;
          at = s.at;
        }
      }
      const next = moveClips(t, d.ids, delta, d.dt, { duplicate: d.dup, insert: e.ctrlKey }, defaultIds);
      ui.set({ preview: next, snapAt: at });
      const sign = delta < 0 ? '−' : '+';
      setReadout({ x: e.clientX + 14, y: e.clientY + 16, text: `${sign}${formatTimecode(Math.abs(delta), fps)}${e.ctrlKey ? '  insert' : ''}${d.dup ? '  copy' : ''}` });
    } else if (d.kind === 'trim') {
      let delta = Math.round(dx / pxNow);
      const clips = d.ids.map((id) => t.clips[id]).filter((c): c is Clip => !!c);
      const edgePos = d.edge === 'start' ? clips[0]!.start : clipEnd(clips[0]!);
      let at: number | null = null;
      if (ui.snapping) {
        const s = snapFrame(snapTargets(t, { playhead: getPlayhead(), exclude: d.ids }), edgePos + delta, SNAP_PX / pxNow);
        if (s != null) {
          delta = s - edgePos;
          at = s;
        }
      }
      const ripple = e.ctrlKey;
      d.ripple = ripple;
      const next = trimClips(t, getDoc().media, d.ids, d.edge, delta, { ripple });
      ui.set({ preview: next, snapAt: at });
      const c = next.clips[d.ids[0]!];
      if (c) setReadout({ x: e.clientX + 14, y: e.clientY + 16, text: `${ripple ? 'Ripple · ' : ''}${formatTimecode(c.duration, fps)}` });
    } else if (d.kind === 'marquee') {
      const rect = contentRef.current!.getBoundingClientRect();
      const x0 = d.startX - rect.left;
      const y0 = d.startY - rect.top;
      const x1 = e.clientX - rect.left;
      const y1 = e.clientY - rect.top;
      const box = { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
      setMarquee(box);
      const f0 = (box.left - HEADER_W) / pxNow;
      const f1 = (box.left + box.width - HEADER_W) / pxNow;
      const hit: string[] = [];
      for (const r of allRows) {
        if (r.top + r.height < box.top || r.top > box.top + box.height) continue;
        for (const c of clipsOnTrack(t, r.track.id)) if (c.start < f1 && clipEnd(c) > f0 && !r.track.locked) hit.push(c.id);
      }
      ui.select({ clipIds: [...new Set([...d.initial, ...expandSelection(t, hit)])] });
    }
  };

  const finishDrag = (commit: boolean, e?: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    const ui = useUi.getState();
    const result = ui.preview;
    ui.set({ preview: null, snapAt: null });
    setMarquee(null);
    setReadout(null);
    if (!d || !commit) return;
    if ((d.kind === 'move' || d.kind === 'trim') && d.started && result && result !== d.base) {
      const label = d.kind === 'trim' ? (d.ripple ? 'Ripple trim' : 'Trim') : d.dup ? 'Duplicate' : e?.ctrlKey ? 'Insert move' : 'Move';
      useProject.getState().commitTimeline(label, result);
      if (d.kind === 'move' && d.dup) ui.select({ clipIds: Object.keys(result.clips).filter((id) => !d.base.clips[id]) });
      edit.pruneSelection();
    } else if (d.kind === 'marquee' && !d.started && e) {
      // A plain click on empty track space selects the gap there (Delete closes it).
      const { frame, row } = locate(e.clientX, e.clientY);
      if (row && frame >= 0) {
        const g = gapAt(d.base, row.track.id, Math.floor(frame));
        if (g) ui.select({ gap: { ...g, trackId: row.track.id } });
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const clipEl = (e.target as HTMLElement).closest('[data-clip-id]') as HTMLElement | null;
    if (!clipEl || useUi.getState().tool !== 'select') return;
    const clip = getTimeline().clips[clipEl.dataset.clipId!];
    if (!clip) return;
    // Like Premiere: open the clip in the source monitor with its range marked.
    const fpsNow = getTimeline().settings.fps;
    useSource.getState().load(clip.mediaId);
    useSource.getState().set({ inSec: clip.sourceIn / fpsNow, outSec: (clip.sourceIn + clip.duration) / fpsNow, timeSec: clip.sourceIn / fpsNow });
    useUi.getState().set({ focus: 'source' });
  };

  // ---------------------------------------------------------------- drag & drop from bin / source / OS
  const onDragOver = (e: React.DragEvent) => {
    const src = activeDrag();
    const files = isOsFileDrag(e);
    if (!src && !files) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!src) return;
    const { frame, row } = locate(e.clientX, e.clientY);
    const base = getTimeline();
    const { frame: f, at } = snapOne(base, Math.max(0, frame));
    const mode = e.ctrlKey ? 'insert' : 'overwrite';
    const key = `${f}|${row?.track.id ?? ''}|${mode}`;
    if (key === dropKey.current) return;
    dropKey.current = key;
    useUi.getState().set({ preview: edit.previewPlacement(src, f, mode, overrideFor(base, row)), snapAt: at });
  };

  const clearDrop = () => {
    dropKey.current = '';
    useUi.getState().set({ preview: null, snapAt: null });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const base = getTimeline();
    const { frame, row } = locate(e.clientX, e.clientY);
    const { frame: f } = snapOne(base, Math.max(0, frame));
    const override = overrideFor(base, row);
    const mode = e.ctrlKey ? 'insert' : 'overwrite';
    clearDrop();
    let src: DragSource | null = activeDrag();
    if (!src) {
      try {
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (raw) src = JSON.parse(raw) as DragSource;
      } catch {
        src = null;
      }
    }
    endDrag();
    useUi.getState().set({ focus: 'timeline' });
    if (src) {
      edit.placeSelection(src, f, mode, override);
      return;
    }
    if (isOsFileDrag(e)) {
      const paths = osFilePaths(e);
      void importPaths(paths).then((items) => {
        // Several files dropped at once are laid end to end.
        let at = f;
        for (const m of items) {
          const end = edit.placeSelection({ mediaId: m.id, inSec: 0, outSec: null, video: true, audio: true }, at, 'overwrite', override);
          if (end != null) at = end;
        }
      });
    }
  };

  // ---------------------------------------------------------------- render
  const selectedSet = useMemo(() => new Set(selection.clipIds), [selection.clipIds]);
  const gaps = useMemo(() => blackGaps(tl), [tl.clips, tl.tracks]);
  const bottomVideo = rows.video[rows.video.length - 1]?.track.id;
  const { inPoint, outPoint } = tl;
  const hasClips = Object.keys(tl.clips).length > 0;

  return (
    <section className={`panel timeline${focused ? ' focused' : ''}`} onPointerDown={() => useUi.getState().set({ focus: 'timeline' })} data-testid="timeline">
      <TimelineToolbar tool={tool} snapping={snapping} px={px} onZoom={(p) => zoomTo(p)} tl={committed} />
      <div className="panel-body">
        <div className="tl-scroll" ref={scrollRef}>
          <div
            ref={contentRef}
            className={`tl-content${tool === 'razor' ? ' razor' : ''}`}
            style={{ width: contentWidth, height: rows.bottom + 31 }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => finishDrag(true, e)}
            onPointerCancel={() => finishDrag(false)}
            onPointerLeave={() => setRazorAt(null)}
            onDoubleClick={onDoubleClick}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              if (!contentRef.current?.contains(e.relatedTarget as Node)) clearDrop();
            }}
            onDrop={onDrop}
          >
            <div className="tl-ruler-row" style={{ width: contentWidth }}>
              <div className="tl-corner">{formatTimecode(duration, fps)}</div>
              <Ruler tl={tl} px={px} scrollLeft={view.left} width={laneWidth} />
            </div>

            {rows.video.map((r) => (
              <TrackRow
                key={r.track.id}
                tl={tl}
                row={r}
                media={media}
                assets={assets}
                offline={offline}
                selected={selectedSet}
                px={px}
                viewFrom={viewFrom}
                viewTo={viewTo}
                blackGaps={r.track.id === bottomVideo ? gaps : undefined}
                gap={selection.gap?.trackId === r.track.id ? selection.gap : null}
              />
            ))}
            <div className="tl-divider" style={{ width: contentWidth }}>
              <div className="tl-divider-head" />
            </div>
            {rows.audio.map((r) => (
              <TrackRow
                key={r.track.id}
                tl={tl}
                row={r}
                media={media}
                assets={assets}
                offline={offline}
                selected={selectedSet}
                px={px}
                viewFrom={viewFrom}
                viewTo={viewTo}
                gap={selection.gap?.trackId === r.track.id ? selection.gap : null}
              />
            ))}
            <div className="tl-add-row">
              <div className="track-header" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className="btn ghost" style={{ height: 24, padding: '0 6px', fontSize: 11.5 }} data-tip="Add a video track on top" onClick={() => useProject.getState().commitTimeline('Add video track', addTrack(getTimeline(), 'video', defaultIds))}>
                  <Plus size={12} /> Video
                </button>
                <button type="button" className="btn ghost" style={{ height: 24, padding: '0 6px', fontSize: 11.5 }} data-tip="Add an audio track at the bottom" onClick={() => useProject.getState().commitTimeline('Add audio track', addTrack(getTimeline(), 'audio', defaultIds))}>
                  <Plus size={12} /> Audio
                </button>
              </div>
            </div>

            {(inPoint != null || outPoint != null) && (
              <div
                className="inout-shade"
                style={{
                  top: RULER_H,
                  left: HEADER_W + (inPoint ?? 0) * px,
                  width: ((outPoint != null ? outPoint + 1 : Math.max(duration, (inPoint ?? 0) + 1)) - (inPoint ?? 0)) * px,
                }}
              />
            )}
            <PlayheadLine px={px} offset={HEADER_W} />
            {snapAt != null && <div className="snap-line" style={{ left: HEADER_W + snapAt * px }} />}
            {razorAt != null && tool === 'razor' && <div className="razor-line" style={{ left: HEADER_W + razorAt * px, top: RULER_H }} />}
            {marquee && <div className="marquee" style={marquee} />}
            {!hasClips && (
              <div className="tl-empty">
                <div className="empty">
                  <div>
                    <h3>Drag clips here to start your edit</h3>
                    Or mark In <kbd>I</kbd> and Out <kbd>O</kbd> in the Source monitor and press <kbd>,</kbd> to insert at the playhead.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {readout && (
        <div className="drag-readout" style={{ left: readout.x, top: readout.y }}>
          {readout.text}
        </div>
      )}
    </section>
  );
}

const TrackRow = memo(function TrackRow(props: {
  tl: TimelineModel;
  row: Row;
  media: ReturnType<typeof getDoc>['media'];
  assets: ReturnType<typeof useAssets.getState>['byPath'];
  offline: Record<string, true>;
  selected: Set<string>;
  px: number;
  viewFrom: number;
  viewTo: number;
  blackGaps?: Range[];
  gap: (Range & { trackId: string }) | null;
}) {
  const { tl, row, px } = props;
  const { track } = row;
  const label = trackLabel(tl, track.id);
  const targeted = track.kind === 'video' ? tl.targetVideoTrackId === track.id : tl.targetAudioTrackId === track.id;
  const clips = clipsOnTrack(tl, track.id).filter((c) => clipEnd(c) >= props.viewFrom && c.start <= props.viewTo);
  const inaudible = track.kind === 'audio' && !isTrackAudible(tl, track);
  return (
    <div className={`tl-row ${track.kind}`} data-track-id={track.id} style={{ height: row.height }}>
      <TrackHeader track={track} label={label} targeted={targeted} />
      <div className={`tl-lane${track.locked ? ' locked' : ''}${inaudible ? ' muted' : ''}${track.hidden ? ' hidden' : ''}`}>
        {props.blackGaps?.map((g) => (
          <div
            key={`b${g.start}`}
            className="gap-black"
            style={{ left: g.start * px, width: (g.end - g.start) * px }}
            data-tip="Black frames: nothing is on any video track here. Click the gap and press Delete to close it."
          >
            {(g.end - g.start) * px > 90 ? 'Black frames' : ''}
          </div>
        ))}
        {props.gap && <div className="gap-selected" style={{ left: props.gap.start * px, width: (props.gap.end - props.gap.start) * px }} />}
        {clips.map((c) => {
          const m = props.media[c.mediaId];
          return (
            <ClipView
              key={c.id}
              clip={c}
              media={m}
              assets={m ? props.assets[m.path] : undefined}
              offline={!!props.offline[c.mediaId]}
              selected={props.selected.has(c.id)}
              linked={isLinked(tl, c)}
              px={px}
              fps={tl.settings.fps}
              viewFrom={props.viewFrom}
              viewTo={props.viewTo}
              rowHeight={row.height}
            />
          );
        })}
      </div>
    </div>
  );
});

function TimelineToolbar({ tool, snapping, px, onZoom, tl }: { tool: string; snapping: boolean; px: number; onZoom: (px: number) => void; tl: TimelineModel }) {
  const frame = usePlayhead((s) => s.frame);
  const fps = tl.settings.fps;
  const { width, height } = FORMATS[tl.settings.format];
  const selection = useUi((s) => s.selection.clipIds);
  const anyLinked = selection.some((id) => tl.clips[id]?.linkId && isLinked(tl, tl.clips[id]!));
  const zoomValue = Math.log(px / MIN_PX_PER_FRAME) / Math.log(MAX_PX_PER_FRAME / MIN_PX_PER_FRAME);
  return (
    <div className="tl-toolbar">
      <span className="tc" data-testid="program-tc" data-tip="Playhead position">
        {formatTimecode(frame, fps)}
      </span>
      <IconButton icon={<MousePointer2 size={16} />} label="Selection tool" kbd="V" active={tool === 'select'} onClick={() => edit.setTool('select')} />
      <IconButton icon={<Scissors size={16} />} label="Razor tool (Shift: all tracks, Alt: one side)" kbd="C" active={tool === 'razor'} onClick={() => edit.setTool('razor')} />
      <IconButton icon={<Magnet size={16} />} label={snapping ? 'Snapping is on' : 'Snapping is off'} kbd="S" active={snapping} onClick={edit.toggleSnapping} />
      <div className="topbar-sep" />
      <IconButton icon={<span style={{ font: '700 15px var(--mono)' }}>{'{'}</span>} label="Mark In" kbd="I" onClick={() => edit.markTimeline('in')} />
      <IconButton icon={<span style={{ font: '700 15px var(--mono)' }}>{'}'}</span>} label="Mark Out" kbd="O" onClick={() => edit.markTimeline('out')} />
      <IconButton icon={<ArrowUpFromLine size={16} />} label="Lift In–Out (leave gap)" kbd=";" onClick={edit.liftMarked} />
      <IconButton icon={<FoldHorizontal size={16} />} label="Extract In–Out (close gap)" kbd="'" onClick={edit.extractMarked} />
      <div className="topbar-sep" />
      <IconButton icon={<SquareSplitHorizontal size={16} />} label="Cut all tracks at playhead" kbd="Ctrl+K" onClick={edit.cutAtPlayhead} />
      <IconButton icon={<ArrowLeftToLine size={16} />} label="Ripple trim clip start to playhead" kbd="Q" onClick={() => edit.rippleTrimToPlayheadCmd('start')} />
      <IconButton icon={<ArrowRightToLine size={16} />} label="Ripple trim clip end to playhead" kbd="W" onClick={() => edit.rippleTrimToPlayheadCmd('end')} />
      <IconButton icon={<Bookmark size={16} />} label="Add marker" kbd="M" onClick={edit.addMarkerAtPlayhead} />
      <IconButton icon={<Link size={16} />} label={anyLinked ? 'Unlink audio & video' : 'Link selected clips'} kbd="Ctrl+L" onClick={edit.toggleLinkSelection} disabled={!selection.length} />
      <IconButton icon={<Group size={16} />} label="Group / ungroup selected clips" kbd="Ctrl+G" onClick={edit.toggleGroupSelection} disabled={!selection.length} />
      <div className="grow" />
      <span className="tc dim" data-tip="Timeline format (change it in the Inspector when nothing is selected)">
        {width}×{height} · {fps} fps
      </span>
      <IconButton icon={<ZoomOut size={16} />} label="Zoom out" kbd="−" onClick={() => edit.zoom('out')} />
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={zoomValue}
        aria-label="Timeline zoom"
        data-tip="Zoom (Alt+scroll also zooms)"
        onChange={(e) => onZoom(MIN_PX_PER_FRAME * Math.pow(MAX_PX_PER_FRAME / MIN_PX_PER_FRAME, Number(e.target.value)))}
      />
      <IconButton icon={<ZoomIn size={16} />} label="Zoom in" kbd="+" onClick={() => edit.zoom('in')} />
      <IconButton icon={<Maximize2 size={15} />} label="Zoom to fit" kbd="\" onClick={() => edit.zoom('fit')} />
    </div>
  );
}
