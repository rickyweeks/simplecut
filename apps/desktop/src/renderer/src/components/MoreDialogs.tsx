import { useEffect, useRef, useState } from 'react';
import { Captions, CheckCircle2, ClipboardPaste, Download, GraduationCap, X } from 'lucide-react';
import { ATTRIBUTE_LABELS, CAPTION_STYLES, attributeSources, availableAttributes, captionText, markedRange, type AttributeGroup } from '@simplecut/core';
import { cancelCaptionJob, createCaptions, downloadModel, setCaptionStyle, useCaptionJob } from '../actions/captions';
import { pasteAttributesCmd } from '../actions/visual';
import { useProject } from '../state/project';
import { useSource } from '../state/source';
import { useUi } from '../state/ui';
import { renderText } from '../text/renderText';
import { Modal, formatBytes } from './common';

const close = () => useUi.getState().set({ dialog: null });

// ---------------------------------------------------------------------------
// Paste Attributes (Ctrl+Alt+V)
// ---------------------------------------------------------------------------

export function PasteAttributesDialog() {
  const clipboard = useUi((s) => s.clipboard);
  const count = useUi((s) => s.selection.clipIds.length);
  const available = availableAttributes(attributeSources(clipboard));
  const [chosen, setChosen] = useState<AttributeGroup[]>(available);
  const toggle = (g: AttributeGroup) => setChosen((c) => (c.includes(g) ? c.filter((x) => x !== g) : [...c, g]));
  return (
    <Modal title="Paste attributes" icon={<ClipboardPaste size={18} color="var(--accent-strong)" />} onClose={close} testId="paste-attributes">
      <p className="lead">
        Copy the look of the copied clip onto the {count} selected clip{count === 1 ? '' : 's'}. Each setting only goes onto clips it suits.
      </p>
      {available.length === 0 ? (
        <div className="hint">The copied clips have nothing to paste.</div>
      ) : (
        available.map((g) => (
          <label key={g} className="check-row">
            <input type="checkbox" checked={chosen.includes(g)} onChange={() => toggle(g)} data-testid={`attr-${g}`} />
            {ATTRIBUTE_LABELS[g]}
          </label>
        ))
      )}
      <div className="modal-foot" style={{ padding: '14px 0 0' }}>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!chosen.length} onClick={() => pasteAttributesCmd(chosen)} data-testid="attr-paste">
          Paste
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Auto captions
// ---------------------------------------------------------------------------

const previews = new Map<string, string>();
function captionPreview(styleId: string): string {
  let url = previews.get(styleId);
  if (url) return url;
  const W = 480;
  const H = 270;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#2b3a55');
  g.addColorStop(1, '#4a2f3d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Bigger than real captions so the style is easy to judge at thumbnail size.
  const t = captionText('Welcome back!', styleId);
  ctx.drawImage(renderText({ ...t, size: t.size * 2.2, outlineWidth: t.outlineWidth * 2.2, boxPadding: t.boxPadding * 2.2, y: 0.62 }, W, H).canvas, 0, 0);
  url = c.toDataURL('image/jpeg', 0.85);
  previews.set(styleId, url);
  return url;
}

export function CaptionsDialog() {
  const job = useCaptionJob();
  const marked = useProject((s) => markedRange(s.doc.timeline));
  const busy = job.stage === 'downloading' || job.stage === 'audio' || job.stage === 'transcribe';
  const percent = job.fraction != null ? Math.round(job.fraction * 100) : null;
  const what = job.stage === 'downloading' ? 'Downloading the speech model' : job.stage === 'audio' ? 'Preparing the speech' : 'Listening and writing captions';
  return (
    <Modal title="Auto captions" icon={<Captions size={18} color="var(--accent-strong)" />} onClose={busy ? undefined : close} testId="captions-dialog" wide>
      <p className="lead">
        SimpleCut listens to the speech on your timeline{marked ? ' between In and Out' : ''} and writes captions on their own track. It all runs on this PC. The music track is skipped.
      </p>
      <div className="caption-styles">
        {CAPTION_STYLES.map((s) => (
          <button key={s.id} type="button" className={`caption-style${job.styleId === s.id ? ' on' : ''}`} onClick={() => setCaptionStyle(s.id)} disabled={busy} data-testid={`caption-style-${s.id}`}>
            <img src={captionPreview(s.id)} alt="" />
            <span>{s.name}</span>
          </button>
        ))}
      </div>
      {job.stage === 'needsModel' && (
        <div className="callout">
          <Download size={16} />
          <div>
            Captions need a one-time download of the English speech model ({formatBytes(job.modelBytes)}) from the official whisper.cpp repository. It stays on this PC for next time.
          </div>
        </div>
      )}
      {busy && (
        <>
          <div className="progress">
            <div className={percent == null ? 'indeterminate' : ''} style={{ width: `${percent ?? 30}%` }} />
          </div>
          <div className="progress-meta" data-testid="captions-progress">
            <span>
              {what}
              {percent != null ? ` · ${percent}%` : '…'}
            </span>
          </div>
        </>
      )}
      {job.stage === 'done' && (
        <div className="callout ok">
          <CheckCircle2 size={18} />
          <div data-testid="captions-done">{job.message}</div>
        </div>
      )}
      {job.stage === 'error' && <div className="callout error">{job.message}</div>}
      <div className="modal-foot" style={{ padding: '14px 0 0' }}>
        {busy ? (
          <button type="button" className="btn danger" onClick={cancelCaptionJob}>
            Cancel
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={close}>
              {job.stage === 'done' ? 'Done' : 'Close'}
            </button>
            {job.stage === 'needsModel' ? (
              <button type="button" className="btn primary" onClick={() => void downloadModel()} data-testid="captions-download">
                <Download size={14} /> Download ({formatBytes(job.modelBytes)})
              </button>
            ) : job.stage === 'ready' || job.stage === 'error' || job.stage === 'done' ? (
              <button type="button" className="btn primary" onClick={() => void createCaptions()} data-testid="captions-create">
                <Captions size={14} /> {job.stage === 'done' ? 'Redo captions' : 'Create captions'}
              </button>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// First-launch tutorial
// ---------------------------------------------------------------------------

interface Step {
  title: string;
  body: React.ReactNode;
  /** Panel to highlight. */
  target: string;
  /** True once the user has done the step. */
  done: () => boolean;
}

const STEPS: Step[] = [
  {
    title: 'Import your videos',
    body: (
      <>
        Drag video files onto the window, or press <kbd>Ctrl+I</kbd>. The first one opens in the Source monitor (double-click any clip in the bin to open it).
      </>
    ),
    target: '[data-testid="media-bin"]',
    done: () => Object.keys(useProject.getState().doc.media).length > 0,
  },
  {
    title: 'Mark the good part',
    body: (
      <>
        Play with <kbd>Space</kbd> (or <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd>). Press <kbd>I</kbd> where it should start and <kbd>O</kbd> where it should end.
      </>
    ),
    target: '[data-testid="source-monitor"]',
    done: () => useSource.getState().inSec != null && useSource.getState().outSec != null,
  },
  {
    title: 'Put it on the timeline',
    body: (
      <>
        Press <kbd>,</kbd> to insert it at the playhead (or drag it down). Repeat for more clips.
      </>
    ),
    target: '[data-testid="timeline"]',
    done: () => Object.keys(useProject.getState().doc.timeline.clips).length > 0,
  },
  {
    title: 'Cut out mistakes',
    body: (
      <>
        Move the playhead to a mistake and press <kbd>Ctrl+K</kbd> to cut there (or use the razor, <kbd>C</kbd>). Select the bad part and press <kbd>Delete</kbd>: the gap closes by itself.
      </>
    ),
    target: '[data-testid="timeline"]',
    done: () => useProject.getState().history.entries.some((e) => /^(Razor|Add edit|Ripple delete|Delete)/.test(e.label)),
  },
  {
    title: 'Export for YouTube',
    body: (
      <>
        When it looks right, click <b>Export for YouTube</b> (<kbd>Ctrl+M</kbd>). That's it — you've made a video!
      </>
    ),
    target: '[data-testid="export-button"]',
    done: () => useUi.getState().dialog === 'export',
  },
];

export function Tutorial() {
  const step = useUi((s) => s.tutorialStep);
  // Re-render when the project, source or dialog changes, so steps complete as you work.
  useProject((s) => s.history);
  useSource((s) => s.mediaId);
  useSource((s) => s.inSec);
  useSource((s) => s.outSec);
  useUi((s) => s.dialog);
  const [ring, setRing] = useState<DOMRect | null>(null);
  const timer = useRef<number>(0);

  const s = step != null ? STEPS[step] : undefined;
  const finish = () => {
    useUi.getState().setPrefs({ tutorialDone: true });
    useUi.getState().set({ tutorialStep: null });
  };

  useEffect(() => {
    if (!s) return;
    const update = () => setRing(document.querySelector(s.target)?.getBoundingClientRect() ?? null);
    update();
    timer.current = window.setInterval(update, 400);
    return () => window.clearInterval(timer.current);
  }, [s]);

  // Move on once the step is done (keyed on that, so re-renders don't keep restarting the timer).
  const done = !!s?.done();
  useEffect(() => {
    if (step == null || !done) return;
    const t = window.setTimeout(() => {
      if (step + 1 >= STEPS.length) {
        finish();
        useUi.getState().toast('Tutorial complete. Hold ? any time to see every shortcut.');
      } else useUi.getState().set({ tutorialStep: step + 1 });
    }, 500);
    return () => window.clearTimeout(t);
  }, [step, done]);

  if (!s || step == null) return null;
  return (
    <>
      {ring && <div className="tour-ring" style={{ left: ring.left - 3, top: ring.top - 3, width: ring.width + 6, height: ring.height + 6 }} />}
      <div className="tour-card" data-testid="tutorial">
        <div className="tour-head">
          <GraduationCap size={16} />
          <span className="tour-count">
            Step {step + 1} of {STEPS.length}
          </span>
          <div className="grow" />
          <button type="button" className="icon-link" onClick={finish} data-tip="Skip the tutorial" data-testid="tutorial-skip">
            <X size={14} />
          </button>
        </div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="tour-dots">
          {STEPS.map((_, i) => (
            <span key={i} className={i < step ? 'done' : i === step ? 'on' : ''} />
          ))}
          <div className="grow" />
          <button type="button" className="btn ghost" onClick={() => (step + 1 >= STEPS.length ? finish() : useUi.getState().set({ tutorialStep: step + 1 }))} data-testid="tutorial-next">
            {step + 1 >= STEPS.length ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
}
