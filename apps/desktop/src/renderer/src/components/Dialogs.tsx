import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSearch, LifeBuoy, Settings, Upload } from 'lucide-react';
import {
  ENCODER_LABELS,
  FORMATS,
  YOUTUBE_AUDIO_BITRATE,
  basename,
  blackGaps,
  formatTimecode,
  markedRange,
  timelineDuration,
  youtubeBitrate,
  type Range,
} from '@simplecut/core';
import type { EncoderInfo, ExportProgressEvent, ExportResult, RecoveryEntry } from '../../../shared/api';
import { flushLiveEdit } from '../actions/edit';
import { recoverProject, relinkMedia } from '../actions/project';
import { duckRegionsFor } from '../state/ducking';
import { textPng } from '../text/renderText';
import { api } from '../lib/api';
import { SHORTCUT_GROUPS } from '../shortcuts';
import { useAssets } from '../state/assets';
import { getDoc, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { Kbd, Modal, formatBytes, formatEta } from './common';

const close = () => useUi.getState().set({ dialog: null });

// ---------------------------------------------------------------------------
// Export for YouTube
// ---------------------------------------------------------------------------

export function ExportDialog() {
  const tl = useProject((s) => s.doc.timeline);
  const name = useProject((s) => s.meta.name);
  const encoderPref = useUi((s) => s.prefs.encoder);
  const offline = useAssets((s) => s.offline);
  const marked = markedRange(tl);
  const [rangeMode, setRangeMode] = useState<'all' | 'inout'>(marked ? 'inout' : 'all');
  const [output, setOutput] = useState<string | null>(null);
  const [encoders, setEncoders] = useState<EncoderInfo | null>(null);
  const [phase, setPhase] = useState<'setup' | 'running' | 'done' | 'error'>('setup');
  const [progress, setProgress] = useState<ExportProgressEvent | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    void api.exporter.encoders().then(setEncoders);
    return api.exporter.onProgress(setProgress);
  }, []);

  const fps = tl.settings.fps;
  const { width, height } = FORMATS[tl.settings.format];
  const range: Range = rangeMode === 'inout' && marked ? marked : { start: 0, end: timelineDuration(tl) };
  const seconds = (range.end - range.start) / fps;
  const bitrate = youtubeBitrate(width, height, fps);
  const estimate = ((bitrate.target + YOUTUBE_AUDIO_BITRATE) * seconds) / 8;
  const gapsInRange = blackGaps(tl).filter((g) => g.start < range.end && g.end > range.start);
  const offlineUsed = new Set(Object.values(tl.clips).filter((c) => offline[c.mediaId]).map((c) => c.mediaId)).size;
  const encoderName =
    encoderPref === 'software' || !encoders ? ENCODER_LABELS.libx264 : `${ENCODER_LABELS[encoders.preferred]}${encoders.preferred === 'libx264' ? '' : ' (hardware)'}`;

  const choose = async () => {
    const p = await api.dialogs.exportVideo(name);
    if (p) setOutput(p);
    return p;
  };

  const start = async () => {
    const out = output ?? (await choose());
    if (!out) return;
    flushLiveEdit();
    setPhase('running');
    setProgress(null);
    const doc = getDoc();
    // Titles are drawn by the same renderer the preview uses, so they export pixel-identical.
    const { width: W, height: H } = FORMATS[doc.timeline.settings.format];
    const textImages: Record<string, Uint8Array> = {};
    for (const c of Object.values(doc.timeline.clips)) {
      if (c.text && c.start < range.end && c.start + c.duration > range.start) textImages[c.id] = await textPng(c.text, W, H);
    }
    const r = await api.exporter.start({ doc, range, outputPath: out, encoder: encoderPref, textImages, duckRegions: duckRegionsFor(doc.timeline) });
    setResult(r);
    setPhase(r.ok ? 'done' : r.cancelled ? 'setup' : 'error');
    if (r.cancelled) useUi.getState().toast('Export cancelled.');
  };

  const running = phase === 'running';
  return (
    <Modal title="Export for YouTube" icon={<Upload size={18} color="var(--accent-strong)" />} onClose={running ? undefined : close} testId="export-dialog">
      {phase === 'done' && result?.ok ? (
        <>
          <div className="callout ok">
            <CheckCircle2 size={18} />
            <div>
              Your video is ready.
              <br />
              {result.elapsedSec != null && `Exported in ${formatEta(result.elapsedSec).replace(' left', '')}`}
              {result.bytes != null && ` · ${formatBytes(result.bytes)}`}
              {result.encoder && ` · ${ENCODER_LABELS[result.encoder]}`}
            </div>
          </div>
          <div className="path-box">
            <span data-testid="export-output">{result.outputPath}</span>
          </div>
        </>
      ) : (
        <>
          <div className="kv">
            <span>Video</span>
            <span>
              H.264 MP4 · {width}×{height} · {fps} fps · {bitrate.target / 1e6} Mbps
            </span>
            <span>Audio</span>
            <span>AAC · 48 kHz stereo · {YOUTUBE_AUDIO_BITRATE / 1000} kbps</span>
            <span>Encoder</span>
            <span>{encoderName}</span>
            <span>Length</span>
            <span>{formatTimecode(range.end - range.start, fps)}</span>
            <span>Estimated size</span>
            <span>{formatBytes(estimate)}</span>
            <span>Loudness</span>
            <span data-tip={tl.masterGainDb == null ? 'Inspector → Sound → Normalize for YouTube' : undefined}>
              {tl.masterGainDb != null && tl.loudness ? `Normalized (~${(tl.loudness.integratedLufs + tl.masterGainDb).toFixed(1)} LUFS)` : 'Not normalized (optional: Inspector → Sound)'}
            </span>
          </div>
          <div className="field" style={{ padding: '4px 0', gridTemplateColumns: '120px 1fr' }}>
            <label>Range</label>
            <div className="seg">
              <button type="button" className={rangeMode === 'all' ? 'on' : ''} onClick={() => setRangeMode('all')} disabled={running}>
                Whole timeline
              </button>
              <button type="button" className={rangeMode === 'inout' ? 'on' : ''} onClick={() => setRangeMode('inout')} disabled={running || !marked} data-tip={marked ? undefined : 'Mark In (I) and Out (O) on the timeline to export part of it'}>
                In to Out
              </button>
            </div>
          </div>
          <div className="path-box" style={{ marginTop: 8 }}>
            <span>{output ?? 'Choose where to save the MP4…'}</span>
            <button type="button" className="btn" onClick={() => void choose()} disabled={running}>
              {output ? 'Change…' : 'Choose…'}
            </button>
          </div>
          {gapsInRange.length > 0 && !running && (
            <div className="callout warn">
              <AlertTriangle size={16} />
              <div>
                {gapsInRange.length} black gap{gapsInRange.length === 1 ? '' : 's'} (first at {formatTimecode(gapsInRange[0]!.start, fps)}). They will appear as black frames. Click a hatched gap on the timeline and press Delete to close it.
              </div>
            </div>
          )}
          {offlineUsed > 0 && (
            <div className="callout error">
              <AlertTriangle size={16} />
              <div>{offlineUsed} media file{offlineUsed === 1 ? ' is' : 's are'} offline. Relink before exporting.</div>
            </div>
          )}
          {running && (
            <>
              <div className="progress">
                <div style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
              </div>
              <div className="progress-meta" data-testid="export-progress">
                <span>
                  {Math.round((progress?.fraction ?? 0) * 100)}% · {progress?.label ?? 'Starting…'}
                </span>
                <span>
                  {formatEta(progress?.etaSec ?? null)} · {formatBytes(progress?.bytesWritten ?? 0)} of ~{formatBytes(estimate)}
                </span>
              </div>
            </>
          )}
          {phase === 'error' && result?.error && <div className="callout error">{result.error}</div>}
        </>
      )}
      <div className="modal-foot" style={{ padding: '14px 0 0' }}>
        {phase === 'done' && result?.outputPath ? (
          <>
            <button type="button" className="btn" onClick={() => api.shell.showItemInFolder(result.outputPath!)}>
              Show in folder
            </button>
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </>
        ) : running ? (
          <button type="button" className="btn danger" onClick={() => void api.exporter.cancel()} data-testid="export-cancel">
            Cancel export
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={close}>
              Close
            </button>
            <button type="button" className="btn primary" onClick={() => void start()} disabled={seconds <= 0 || offlineUsed > 0} data-testid="export-start">
              <Upload size={14} /> Export
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Relink missing media
// ---------------------------------------------------------------------------

export function RelinkDialog() {
  const media = useProject((s) => s.doc.media);
  const offline = useAssets((s) => s.offline);
  const missing = Object.values(media).filter((m) => offline[m.id]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (missing.length === 0) {
      useUi.getState().toast('All media found.');
      close();
    }
  }, [missing.length]);

  return (
    <Modal
      title="Some media is missing"
      icon={<FileSearch size={18} color="var(--warn)" />}
      onClose={close}
      wide
      testId="relink-dialog"
      footer={
        <>
          <div className="grow" style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Missing clips show as red “Media offline” on the timeline until you relink them.
          </div>
          <button type="button" className="btn" onClick={close}>
            Keep offline
          </button>
        </>
      }
    >
      <p>These files were moved, renamed or are on a drive that isn't connected. Locate one and SimpleCut will look for the others in the same folder.</p>
      <ul className="missing-list">
        {missing.map((m) => (
          <li key={m.id}>
            <div className="grow">
              <div className="name">{m.name}</div>
              <div className="where">Last seen at {m.path}</div>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={async () => {
                const p = await api.dialogs.locateMedia(basename(m.path));
                if (!p) return;
                setBusy(m.id);
                await relinkMedia(m.id, p);
                setBusy(null);
              }}
            >
              {busy === m.id ? 'Linking…' : 'Locate…'}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

export function RecoveryDialog() {
  const [entries, setEntries] = useState<RecoveryEntry[] | null>(null);
  useEffect(() => {
    void api.recovery.list().then((list) => {
      setEntries(list);
      if (!list.length) close();
    });
  }, []);
  if (!entries?.length) return null;
  const discard = async (id: string) => {
    await api.recovery.clear(id);
    const rest = entries.filter((e) => e.id !== id);
    setEntries(rest);
    if (!rest.length) close();
  };
  return (
    <Modal title="Recover unsaved work?" icon={<LifeBuoy size={18} color="var(--accent-strong)" />} onClose={close} testId="recovery-dialog">
      <p>SimpleCut didn't close normally last time. It autosaved your changes:</p>
      <ul className="missing-list">
        {entries.map((e) => (
          <li key={e.id}>
            <div className="grow">
              <div className="name">{e.name}</div>
              <div className="where">
                Autosaved {new Date(e.savedAt).toLocaleString()}
                {e.projectPath ? ` · ${e.projectPath}` : ' · never saved'}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => void discard(e.id)}>
              Discard
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                close();
                void recoverProject(e.id, e.name, e.projectPath);
              }}
            >
              Recover
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsDialog() {
  const prefs = useUi((s) => s.prefs);
  const setPrefs = useUi((s) => s.setPrefs);
  const [encoders, setEncoders] = useState<EncoderInfo | null>(null);
  useEffect(() => {
    void api.exporter.encoders().then(setEncoders);
  }, []);
  const hw = encoders?.available.filter((e) => e !== 'libx264') ?? [];
  return (
    <Modal title="Settings" icon={<Settings size={18} />} onClose={close} footer={<button type="button" className="btn primary" onClick={close}>Done</button>}>
      <div className="field" style={{ padding: '6px 0', gridTemplateColumns: '150px 1fr' }}>
        <label>Delete key</label>
        <div className="seg">
          <button type="button" className={prefs.rippleDelete ? 'on' : ''} onClick={() => setPrefs({ rippleDelete: true })}>
            Ripple delete (close gap)
          </button>
          <button type="button" className={!prefs.rippleDelete ? 'on' : ''} onClick={() => setPrefs({ rippleDelete: false })}>
            Leave gap
          </button>
        </div>
      </div>
      <div className="field" style={{ padding: '6px 0', gridTemplateColumns: '150px 1fr' }}>
        <label>Export encoder</label>
        <div className="seg">
          <button type="button" className={prefs.encoder === 'auto' ? 'on' : ''} onClick={() => setPrefs({ encoder: 'auto' })}>
            Automatic
          </button>
          <button type="button" className={prefs.encoder === 'software' ? 'on' : ''} onClick={() => setPrefs({ encoder: 'software' })}>
            Software only
          </button>
        </div>
      </div>
      <p style={{ fontSize: 12 }}>
        {encoders == null
          ? 'Checking your graphics card…'
          : hw.length
            ? `Hardware encoding available: ${hw.map((e) => ENCODER_LABELS[e]).join(', ')}. Automatic uses it and falls back to software if it ever fails.`
            : 'No hardware encoder was found, so exports use software x264 (slower, same quality).'}
      </p>
      <div className="field" style={{ padding: '6px 0', gridTemplateColumns: '150px 1fr' }}>
        <label>Playback resolution</label>
        <div className="seg">
          {([1, 0.5, 0.25] as const).map((s) => (
            <button key={s} type="button" className={prefs.playbackScale === s ? 'on' : ''} onClick={() => setPrefs({ playbackScale: s })}>
              {s === 1 ? 'Full' : s === 0.5 ? 'Half' : 'Quarter'}
            </button>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        SimpleCut {api.versions.app} · Electron {api.versions.electron} · Chromium {api.versions.chrome}
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Hold ? for shortcuts
// ---------------------------------------------------------------------------

export function ShortcutSheet() {
  return (
    <div className="shortcut-sheet" onPointerDown={() => useUi.getState().set({ shortcutsVisible: false })} data-testid="shortcut-sheet">
      <h2>Keyboard shortcuts</h2>
      <div className="sub">Same keys as Adobe Premiere Pro. Release ? to close.</div>
      <div className="shortcut-groups">
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title} className="shortcut-group">
            <h3>{g.title}</h3>
            {g.items.map(([label, keys]) => (
              <div key={label} className="shortcut-row">
                <span>{label}</span>
                <span className="keys">
                  <Kbd keys={keys.join(' / ')} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
