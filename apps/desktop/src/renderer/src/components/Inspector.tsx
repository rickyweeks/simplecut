import { useEffect, useRef } from 'react';
import { FolderSearch, History, PanelRightClose, PanelRightOpen, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  FORMATS,
  FRAME_RATES,
  MARKER_COLORS,
  blackGaps,
  changeSettings,
  clipEnd,
  formatDuration,
  formatTimecode,
  isLinked,
  proxyReasons,
  reframeForFormat,
  timelineDuration,
  trackLabel,
  updateMarker,
  type FormatPreset,
  type FrameRate,
  type MediaItem,
  type Timeline,
} from '@simplecut/core';
import * as edit from '../actions/edit';
import { api } from '../lib/api';
import { useAssets } from '../state/assets';
import { getDoc, getTimeline, useProject } from '../state/project';
import { useSource } from '../state/source';
import { useUi } from '../state/ui';
import { IconButton, formatBytes } from './common';
import { AudioClipSection, MixSection, MusicSection, TitleSection, TransitionSection } from './InspectorSections';
import { ColorSection, SilenceSection, SpeedSection, TransformSection, YouTubeSection } from './InspectorVisual';
import { MARKER_HEX } from './timeline/Ruler';

export function Inspector() {
  const open = useUi((s) => s.inspectorOpen);
  const tab = useUi((s) => s.inspectorTab);
  const set = useUi((s) => s.set);
  if (!open) {
    return (
      <aside className="inspector collapsed">
        <IconButton icon={<PanelRightOpen size={16} />} label="Show inspector" onClick={() => set({ inspectorOpen: true })} />
        <IconButton icon={<SlidersHorizontal size={16} />} label="Properties" onClick={() => set({ inspectorOpen: true, inspectorTab: 'properties' })} />
        <IconButton icon={<History size={16} />} label="History" onClick={() => set({ inspectorOpen: true, inspectorTab: 'history' })} />
      </aside>
    );
  }
  return (
    <aside className="inspector" data-testid="inspector">
      <div className="tabs">
        <button type="button" className={tab === 'properties' ? 'on' : ''} onClick={() => set({ inspectorTab: 'properties' })}>
          Properties
        </button>
        <button type="button" className={tab === 'history' ? 'on' : ''} onClick={() => set({ inspectorTab: 'history' })} data-tip="Every change you made — click one to go back to it" data-kbd="Ctrl+Z">
          History
        </button>
        <div className="grow" />
        <IconButton icon={<PanelRightClose size={16} />} label="Hide inspector" onClick={() => set({ inspectorOpen: false })} small />
      </div>
      <div className="inspector-scroll">{tab === 'properties' ? <Properties /> : <HistoryList />}</div>
    </aside>
  );
}

function Properties() {
  const selection = useUi((s) => s.selection);
  // Show live values while a slider is being dragged (the preview), else the committed ones.
  const committed = useProject((s) => s.doc.timeline);
  const tl = useUi((s) => s.preview) ?? committed;
  const media = useProject((s) => s.doc.media);
  const marker = selection.markerId ? tl.markers.find((m) => m.id === selection.markerId) : undefined;
  if (marker) return <MarkerProps tl={tl} markerId={marker.id} />;
  if (selection.transition) return <TransitionSection tl={tl} clipId={selection.transition.clipId} edge={selection.transition.edge} />;
  if (selection.gap) {
    const g = selection.gap;
    return (
      <div className="section">
        <h4>Gap</h4>
        <Field label="Track" value={trackLabel(tl, g.trackId)} />
        <Field label="Starts" value={formatTimecode(g.start, tl.settings.fps)} mono />
        <Field label="Length" value={formatTimecode(g.end - g.start, tl.settings.fps)} mono />
        <div className="hint">Press Delete to close this gap: everything after it moves earlier on every track that is empty here.</div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => edit.deleteSelection()} data-tip="Close gap" data-kbd="Delete">
            Close gap
          </button>
        </div>
      </div>
    );
  }
  if (selection.clipIds.length) return <ClipProps tl={tl} media={media} ids={selection.clipIds} />;
  if (selection.mediaIds.length === 1 && media[selection.mediaIds[0]!]) return <MediaProps m={media[selection.mediaIds[0]!]!} />;
  return <TimelineProps tl={tl} />;
}

function Field({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children ?? <div className={`value${mono ? ' mono' : ''}`}>{value}</div>}
    </div>
  );
}

function TimelineProps({ tl }: { tl: Timeline }) {
  const fps = tl.settings.fps;
  const gaps = blackGaps(tl);
  const ripple = useUi((s) => s.prefs.rippleDelete);
  const setPrefs = useUi((s) => s.setPrefs);
  const hasClips = Object.keys(tl.clips).length > 0;

  const change = async (patch: { format?: FormatPreset; fps?: FrameRate }) => {
    if (patch.fps && patch.fps !== fps && hasClips) {
      const r = await api.dialogs.confirm({
        message: `Change the timeline to ${patch.fps} fps?`,
        detail: 'Every cut is moved to the nearest frame at the new rate. You can undo this.',
        buttons: ['Change', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r !== 0) return;
    }
    let next = changeSettings(getTimeline(), patch);
    // Shorts (9:16) fill the frame with every clip; back to 16:9 letterboxes again.
    if (patch.format && (patch.format === 'vertical') !== (tl.settings.format === 'vertical')) next = reframeForFormat(next, getDoc().media, patch.format);
    useProject.getState().commitTimeline(patch.format === 'vertical' ? 'Shorts mode' : 'Timeline settings', next);
  };

  return (
    <>
      <div className="section">
        <h4>Timeline</h4>
        <Field label="Format">
          <select value={tl.settings.format} onChange={(e) => void change({ format: e.target.value as FormatPreset })} data-testid="format-select">
            {(Object.keys(FORMATS) as FormatPreset[]).map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Frame rate">
          <div className="seg">
            {FRAME_RATES.map((r) => (
              <button key={r} type="button" className={fps === r ? 'on' : ''} onClick={() => void change({ fps: r })}>
                {r}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Length" value={formatTimecode(timelineDuration(tl), fps)} mono />
        {!tl.settings.locked && <div className="hint">The format and frame rate will match the first video you add. You can change them any time.</div>}
      </div>
      <YouTubeSection tl={tl} onShorts={(on) => void change({ format: on ? 'vertical' : '1080p' })} />
      <MixSection tl={tl} />
      <div className="section">
        <h4>Black frames</h4>
        {gaps.length === 0 ? (
          <div className="hint">{hasClips ? 'None — there is always a picture on screen.' : 'Gaps with no video show up here and are hatched red on the timeline.'}</div>
        ) : (
          <>
            <div className="hint warn-text">
              {gaps.length} gap{gaps.length === 1 ? '' : 's'} with no video ({formatDuration(gaps.reduce((n, g) => n + g.end - g.start, 0) / fps)} total).
            </div>
            <div className="actions">
              {gaps.slice(0, 6).map((g) => (
                <button key={g.start} type="button" className="btn" onClick={() => edit.seekProgram(g.start)} data-tip="Jump to this gap">
                  {formatTimecode(g.start, fps)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="section">
        <h4>Editing</h4>
        <Field label="Delete key">
          <div className="seg" data-tip="What Delete/Backspace does to the space a clip leaves">
            <button type="button" className={ripple ? 'on' : ''} onClick={() => setPrefs({ rippleDelete: true })}>
              Close gap
            </button>
            <button type="button" className={!ripple ? 'on' : ''} onClick={() => setPrefs({ rippleDelete: false })}>
              Leave gap
            </button>
          </div>
        </Field>
        <div className="hint">Tip: select a clip and look here for its details. Hold ? for every shortcut.</div>
      </div>
    </>
  );
}

function ClipProps({ tl, media, ids }: { tl: Timeline; media: Record<string, MediaItem>; ids: string[] }) {
  const fps = tl.settings.fps;
  const clips = ids.map((id) => tl.clips[id]).filter((c) => c !== undefined);
  if (!clips.length) return null;
  if (clips.length > 1) {
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map(clipEnd));
    const audio = clips.filter((x) => x.kind === 'audio');
    const pictures = clips.filter((x) => x.kind === 'video' && !x.text && media[x.mediaId]);
    return (
      <>
      {pictures.length > 0 && <TransformSection clips={pictures} />}
      {pictures.length > 0 && <ColorSection clips={pictures} />}
      {clips.some((x) => !x.text && media[x.mediaId]) && <SpeedSection clips={clips.filter((x) => !x.text && media[x.mediaId])} media={media} />}
      {audio.length > 0 && <AudioClipSection tl={tl} clips={audio} media={media[audio[0]!.mediaId]} />}
      {audio.length > 0 && <SilenceSection />}
      <div className="section">
        <h4>{clips.length} clips selected</h4>
        <Field label="Span" value={`${formatTimecode(start, fps)} – ${formatTimecode(end, fps)}`} mono />
        <ClipActions linked={clips.some((c) => isLinked(tl, c))} />
      </div>
      </>
    );
  }
  const c = clips[0]!;
  const m = media[c.mediaId];
  if (c.text) return <TitleSection clip={c} fps={fps} />;
  const onMusic = tl.tracks.find((t) => t.id === c.trackId)?.music;
  return (
    <>
    {c.kind === 'video' && m && <TransformSection clips={[c]} />}
    {c.kind === 'video' && m && <ColorSection clips={[c]} />}
    {m && <SpeedSection clips={[c]} media={media} />}
    {c.kind === 'audio' && <AudioClipSection tl={tl} clips={[c]} media={m} />}
    {c.kind === 'audio' && !onMusic && <SilenceSection />}
    {onMusic && <MusicSection media={m} />}
    <div className="section">
      <h4>{c.kind === 'video' ? 'Video clip' : 'Audio clip'}</h4>
      <Field label="Media" value={m?.name ?? 'Missing'} />
      <Field label="Track" value={trackLabel(tl, c.trackId)} mono />
      <Field label="Starts" value={formatTimecode(c.start, fps)} mono />
      <Field label="Ends" value={formatTimecode(clipEnd(c), fps)} mono />
      <Field label="Length" value={formatTimecode(c.duration, fps)} mono />
      <Field label="Source in" value={formatTimecode(Math.round(c.sourceIn), fps)} mono />
      <Field label="Linked" value={isLinked(tl, c) ? 'Yes — moves with its other half' : 'No'} />
      <ClipActions linked={isLinked(tl, c)} onOpen={() => {
        useSource.getState().load(c.mediaId);
        useSource.getState().set({ inSec: c.sourceIn / fps, outSec: (c.sourceIn + c.duration * (c.speed ?? 1)) / fps, timeSec: c.sourceIn / fps });
      }} path={m?.path} />
      <div className="hint">{c.kind === 'video' ? 'Transitions: Ctrl+D at a cut, or drag one from the Transitions tab.' : 'Crossfade into the next clip with Shift+Ctrl+D.'}</div>
    </div>
    </>
  );
}

function ClipActions({ linked, onOpen, path }: { linked: boolean; onOpen?: () => void; path?: string }) {
  return (
    <div className="actions">
      {onOpen && (
        <button type="button" className="btn" onClick={onOpen} data-tip="Open in the Source monitor with this clip's range marked (or double-click the clip)">
          Open in Source
        </button>
      )}
      <button type="button" className="btn" onClick={edit.toggleLinkSelection} data-tip={linked ? 'Unlink audio & video' : 'Link selected clips'} data-kbd="Ctrl+L">
        {linked ? 'Unlink' : 'Link'}
      </button>
      <button type="button" className="btn" onClick={edit.toggleGroupSelection} data-tip="Group / ungroup" data-kbd="Ctrl+G">
        Group
      </button>
      <button type="button" className="btn danger" onClick={() => edit.deleteSelection()} data-tip="Delete (closes the gap)" data-kbd="Delete">
        <Trash2 size={13} /> Delete
      </button>
      {path && (
        <button type="button" className="btn ghost" onClick={() => api.shell.showItemInFolder(path)} data-tip="Show the original file in Explorer">
          <FolderSearch size={13} /> Show file
        </button>
      )}
    </div>
  );
}

function MediaProps({ m }: { m: MediaItem }) {
  const assets = useAssets((s) => s.byPath[m.path]);
  const offline = useAssets((s) => !!s.offline[m.id]);
  const reasons = proxyReasons(m);
  const reasonText: Record<string, string> = {
    vfr: 'variable frame rate (phone footage) — conformed for exact frames',
    resolution: 'very high resolution',
    bitrate: 'very high bitrate',
    codec: 'a format the preview cannot play directly',
  };
  return (
    <div className="section">
      <h4>Media</h4>
      <Field label="Name" value={m.name} />
      <Field label="Type" value={m.kind === 'video' ? 'Video' : m.kind === 'audio' ? 'Audio' : 'Image'} />
      {m.kind !== 'image' && <Field label="Duration" value={formatDuration(m.durationSec)} mono />}
      {m.hasVideo && <Field label="Size" value={`${m.width}×${m.height}`} mono />}
      {m.kind === 'video' && <Field label="Frame rate" value={`${m.fps.toFixed(m.fps % 1 ? 3 : 0)} fps${m.isVFR ? ' (variable)' : ''}`} mono />}
      <Field label="Codecs" value={[m.videoCodec, m.audioCodec].filter(Boolean).join(' / ') || '—'} />
      <Field label="File size" value={formatBytes(m.fileSize)} mono />
      <Field label="Status" value={offline ? 'Offline — relink it' : assets?.proxy?.state === 'ready' ? 'Optimized for editing' : reasons.length ? 'Optimizing…' : 'Ready'} />
      {reasons.length > 0 && <div className="hint">SimpleCut previews a lightweight copy because of {reasons.map((r) => reasonText[r]).join(', ')}. Exports always use the original.</div>}
      <Field label="Location">
        <div className="path">{m.path}</div>
      </Field>
      <div className="actions">
        <button type="button" className="btn" onClick={() => useSource.getState().load(m.id)}>
          Open in Source
        </button>
        <button type="button" className="btn ghost" onClick={() => api.shell.showItemInFolder(m.path)}>
          <FolderSearch size={13} /> Show file
        </button>
      </div>
    </div>
  );
}

function MarkerProps({ tl, markerId }: { tl: Timeline; markerId: string }) {
  const marker = tl.markers.find((m) => m.id === markerId)!;
  const update = (patch: Parameters<typeof updateMarker>[2], label: string) => useProject.getState().commitTimeline(label, updateMarker(getTimeline(), markerId, patch));
  return (
    <div className="section">
      <h4>Marker</h4>
      <Field label="At" value={formatTimecode(marker.frame, tl.settings.fps)} mono />
      <Field label="Label">
        <input
          type="text"
          defaultValue={marker.label}
          key={marker.id}
          placeholder="e.g. Intro"
          onBlur={(e) => e.target.value !== marker.label && update({ label: e.target.value }, 'Rename marker')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </Field>
      <Field label="Color">
        <div className="swatches">
          {MARKER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${marker.color === c ? ' on' : ''}`}
              style={{ background: MARKER_HEX[c] }}
              aria-label={c}
              data-tip={c}
              onClick={() => update({ color: c }, 'Marker color')}
            />
          ))}
        </div>
      </Field>
      <Field label="Chapter">
        <label className="toggle" data-tip="Chapter markers become YouTube chapter timestamps (export arrives in Phase 4)">
          <input type="checkbox" checked={marker.chapter} onChange={(e) => update({ chapter: e.target.checked }, 'Marker chapter')} />
          YouTube chapter
        </label>
      </Field>
      <div className="actions">
        <button type="button" className="btn danger" onClick={() => edit.deleteSelection()} data-kbd="Delete" data-tip="Delete marker">
          <Trash2 size={13} /> Delete marker
        </button>
      </div>
    </div>
  );
}

function HistoryList() {
  const history = useProject((s) => s.history);
  const jump = useProject((s) => s.jump);
  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [history.index]);
  return (
    <ul className="history-list" data-testid="history">
      {history.entries.map((e, i) => (
        <li
          key={e.id}
          ref={i === history.index ? currentRef : undefined}
          className={i === history.index ? 'current' : i > history.index ? 'future' : ''}
          onClick={() => {
            jump(i);
            useUi.getState().set({ preview: null });
            edit.pruneSelection();
          }}
        >
          {e.label}
          <span className="time">{new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </li>
      ))}
    </ul>
  );
}
