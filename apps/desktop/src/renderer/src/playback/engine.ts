import {
  FORMATS,
  audioTracks,
  clipAt,
  clipEnd,
  clipsOnTrack,
  isTrackAudible,
  timelineDuration,
  videoTracks,
  type Clip,
  type Frame,
  type MediaItem,
  type Timeline,
} from '@simplecut/core';
import { getPlayhead, setPlayhead, usePlayhead } from '../state/playhead';

/**
 * Program monitor playback: composites every visible video track onto a canvas and mixes
 * every audible audio track through Web Audio, in real time.
 *
 * The composite mirrors the export graph exactly: tracks are drawn bottom-up (V1 first,
 * higher tracks cover lower ones), each clip fitted (letterboxed) into the frame on black,
 * and audio tracks are summed without normalization.
 *
 * Media elements come from a small pool and are matched to clips each frame, preferring an
 * element already positioned near the needed time, so playing across a razor cut keeps the
 * same element running seamlessly. Upcoming clips are pre-seeked before they start.
 */

export interface EngineHost {
  /** The timeline to show (a live drag preview if one exists). */
  timeline(): Timeline;
  media(id: string): MediaItem | undefined;
  /** Playable URL (proxy or original), or null when nothing can be played yet. */
  url(media: MediaItem): string | null;
  offline(mediaId: string): boolean;
  /** A proxy is being prepared and the original can't be shown. */
  preparing(media: MediaItem): boolean;
  /** Playback resolution factor (1, 0.5, 0.25). */
  scale(): number;
  /** The browser failed to decode this media's original file. */
  unplayable(media: MediaItem, url: string): void;
}

type SlotKind = 'video' | 'audio';

interface Slot {
  kind: SlotKind;
  el: HTMLVideoElement | HTMLAudioElement;
  url: string;
  lastUsed: number;
  playStartedAt: number;
  gain?: GainNode;
}

interface Need {
  clip: Clip;
  kind: SlotKind;
  /** On screen / audible now (false = pre-roll for an upcoming clip). */
  active: boolean;
}

const MAX_SLOTS: Record<SlotKind, number> = { video: 8, audio: 8 };
const PRELOAD_SEC = 1.5;

export function nextJklRate(rate: number, key: 'j' | 'k' | 'l'): number {
  if (key === 'k') return 0;
  if (key === 'l') return rate <= 0 ? 1 : Math.min(4, rate * 2);
  return rate >= 0 ? -1 : Math.max(-4, rate * 2);
}

export class ProgramEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio: AudioContext;
  private readonly master: GainNode;
  private slots: Slot[] = [];
  private images = new Map<string, HTMLImageElement>();
  private assigned = new Map<string, Slot>();
  private raf = 0;
  private dirty = true;
  private lastFrame = -1;
  private anchorFrame = 0;
  private anchorTime = 0;
  private playing = false;
  private rate = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly pool: HTMLElement,
    private readonly host: EngineHost,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.audio = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
    this.master = this.audio.createGain();
    this.master.connect(this.audio.destination);
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const s of this.slots) {
      s.el.pause();
      s.el.removeAttribute('src');
      s.el.load();
      s.el.remove();
    }
    this.slots = [];
    void this.audio.close();
  }

  /** Something that affects the picture changed (edit, asset, setting): redraw. */
  invalidate(): void {
    this.dirty = true;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  play(rate = 1): void {
    if (rate === 0) return this.pause();
    void this.audio.resume();
    const tl = this.host.timeline();
    const end = timelineDuration(tl);
    let from = getPlayhead();
    // Like Premiere: pressing play at the very end starts over.
    if (rate > 0 && end > 0 && from >= end - 1) from = 0;
    this.anchorFrame = from;
    this.anchorTime = performance.now();
    this.playing = true;
    this.rate = rate;
    setPlayhead(from);
    usePlayhead.setState({ playing: true, rate });
  }

  pause(): void {
    this.playing = false;
    this.rate = 0;
    for (const s of this.slots) if (!s.el.paused) s.el.pause();
    usePlayhead.setState({ playing: false, rate: 0 });
    this.dirty = true;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play(1);
  }

  jkl(key: 'j' | 'k' | 'l'): void {
    this.play(nextJklRate(this.playing ? this.rate : 0, key));
  }

  /** Moves the playhead (keeps playing if playing). */
  seek(frame: Frame): void {
    const f = Math.max(0, Math.round(frame));
    if (this.playing) {
      this.anchorFrame = f;
      this.anchorTime = performance.now();
    }
    setPlayhead(f);
    this.dirty = true;
  }

  step(frames: number): void {
    if (this.playing) this.pause();
    this.seek(getPlayhead() + frames);
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const tl = this.host.timeline();
    const fps = tl.settings.fps;
    let frame = getPlayhead();
    let exact = frame;
    if (this.playing) {
      exact = this.anchorFrame + ((now - this.anchorTime) / 1000) * fps * this.rate;
      const end = timelineDuration(tl);
      if (this.rate > 0 && exact >= end) {
        frame = end;
        setPlayhead(end);
        this.pause();
      } else if (this.rate < 0 && exact <= 0) {
        frame = 0;
        setPlayhead(0);
        this.pause();
      } else {
        const f = Math.floor(exact);
        if (f !== frame) setPlayhead(f);
        frame = f;
      }
    }
    this.sync(tl, frame, exact, now);
    if (this.dirty || this.playing || frame !== this.lastFrame) this.draw(tl, frame);
  };

  /** Matches media elements to the clips that are (or are about to be) on screen, and drives them. */
  private sync(tl: Timeline, frame: Frame, exact: number, now: number): void {
    const fps = tl.settings.fps;
    const forward = this.playing && this.rate > 0;
    const needs: Need[] = [];
    const addTrack = (trackId: string, kind: SlotKind) => {
      const current = clipAt(tl, trackId, frame);
      if (current) needs.push({ clip: current, kind, active: true });
      if (!forward) return;
      const horizon = frame + PRELOAD_SEC * fps * this.rate;
      const next = clipsOnTrack(tl, trackId).find((c) => c.start > frame && c.start <= horizon);
      // A clip that simply continues the current one (a razor cut) inherits its element.
      const continues =
        next && current && next.mediaId === current.mediaId && next.start === clipEnd(current) && next.sourceIn === current.sourceIn + current.duration;
      if (next && !continues) needs.push({ clip: next, kind, active: false });
    };
    for (const t of videoTracks(tl)) if (!t.hidden) addTrack(t.id, 'video');
    for (const t of audioTracks(tl)) if (isTrackAudible(tl, t)) addTrack(t.id, 'audio');

    const urlFor = (n: Need): string | null => {
      const media = this.host.media(n.clip.mediaId);
      if (!media || media.kind === 'image' || this.host.offline(media.id)) return null;
      return this.host.url(media);
    };

    // Keep existing assignments that still fit, then hand out the rest.
    const next = new Map<string, Slot>();
    const used = new Set<Slot>();
    for (const n of needs) {
      const url = urlFor(n);
      const s = this.assigned.get(n.clip.id);
      if (url && s && s.url === url && s.kind === n.kind && !used.has(s)) {
        next.set(n.clip.id, s);
        used.add(s);
      }
    }
    for (const n of needs) {
      if (next.has(n.clip.id)) continue;
      const url = urlFor(n);
      if (!url) continue;
      const target = (n.clip.sourceIn + Math.max(0, frame - n.clip.start)) / fps;
      let best: Slot | null = null;
      let bestDist = Infinity;
      for (const s of this.slots) {
        if (used.has(s) || s.kind !== n.kind || s.url !== url) continue;
        const d = Math.abs(s.el.currentTime - target);
        if (d < bestDist) {
          best = s;
          bestDist = d;
        }
      }
      best ??= this.obtainSlot(n.kind, url, used);
      if (best) {
        next.set(n.clip.id, best);
        used.add(best);
      }
    }
    this.assigned = next;

    for (const s of this.slots) if (!used.has(s) && !s.el.paused) s.el.pause();

    for (const n of needs) {
      const s = next.get(n.clip.id);
      if (!s) continue;
      s.lastUsed = now;
      const { clip } = n;
      const el = s.el;
      if (!n.active) {
        // Pre-roll: park on the first frame of the upcoming clip.
        const t = (clip.sourceIn + 0.5) / fps;
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - t) > 0.5 / fps) el.currentTime = t;
        continue;
      }
      if (forward) {
        const target = (clip.sourceIn + (exact - clip.start)) / fps;
        if (el.playbackRate !== this.rate) el.playbackRate = this.rate;
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.08) el.currentTime = target;
          s.playStartedAt = now;
          void el.play().catch(() => {});
        } else if (!el.seeking && now - s.playStartedAt > 600 && Math.abs(el.currentTime - target) > 0.15) {
          // Drifted (e.g. the decoder stalled): jump back in sync.
          el.currentTime = target + 0.02;
          s.playStartedAt = now;
        }
      } else {
        // Paused, scrubbing or reverse play: show the exact frame (mid-frame avoids rounding to its neighbour).
        if (!el.paused) el.pause();
        const t = (clip.sourceIn + (frame - clip.start) + 0.5) / fps;
        if (!el.seeking && Math.abs(el.currentTime - t) > 0.4 / fps) el.currentTime = t;
      }
    }
  }

  private obtainSlot(kind: SlotKind, url: string, used: Set<Slot>): Slot | null {
    const ofKind = this.slots.filter((s) => s.kind === kind);
    if (ofKind.length >= MAX_SLOTS[kind]) {
      const victim = ofKind.filter((s) => !used.has(s)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) return null;
      victim.url = url;
      victim.el.src = url;
      return victim;
    }
    const el = document.createElement(kind);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    if (el instanceof HTMLVideoElement) {
      // Picture only: sound always comes from audio clips.
      el.muted = true;
      el.playsInline = true;
    }
    el.src = url;
    const slot: Slot = { kind, el, url, lastUsed: performance.now(), playStartedAt: 0 };
    const redraw = () => {
      this.dirty = true;
    };
    el.addEventListener('seeked', redraw);
    el.addEventListener('loadeddata', redraw);
    el.addEventListener('error', () => {
      const media = this.findMediaByUrl(slot.url);
      if (media) this.host.unplayable(media, slot.url);
    });
    if (kind === 'audio') {
      const source = this.audio.createMediaElementSource(el);
      slot.gain = this.audio.createGain();
      source.connect(slot.gain).connect(this.master);
    }
    this.pool.appendChild(el);
    this.slots.push(slot);
    return slot;
  }

  private findMediaByUrl(url: string): MediaItem | undefined {
    const tl = this.host.timeline();
    for (const c of Object.values(tl.clips)) {
      const m = this.host.media(c.mediaId);
      if (m && this.host.url(m) === url) return m;
    }
    return undefined;
  }

  private image(url: string): HTMLImageElement {
    let img = this.images.get(url);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.dirty = true;
      };
      img.src = url;
      this.images.set(url, img);
    }
    return img;
  }

  /** Since when the current frame has been waiting for a decoder (0 = not waiting). */
  private waitingSince = 0;

  private draw(tl: Timeline, frame: Frame): void {
    const { width, height } = FORMATS[tl.settings.format];
    const scale = this.host.scale();
    const cw = Math.max(2, Math.round(width * scale));
    const ch = Math.max(2, Math.round(height * scale));

    // Collect the layers first. If a video is still seeking/decoding, keep showing the
    // previous picture instead of flashing black (but never wait more than half a second).
    type Layer = { kind: 'video'; el: HTMLVideoElement } | { kind: 'image'; el: HTMLImageElement } | { kind: 'offline' };
    const layers: Layer[] = [];
    let message: string | null = null;
    let waiting = false;
    for (const t of videoTracks(tl)) {
      if (t.hidden) continue;
      const c = clipAt(tl, t.id, frame);
      if (!c) continue;
      const media = this.host.media(c.mediaId);
      if (!media) continue;
      if (this.host.offline(media.id)) {
        layers.push({ kind: 'offline' });
        message = `Media offline: ${media.name}`;
        continue;
      }
      if (media.kind === 'image') {
        const url = this.host.url(media);
        const img = url ? this.image(url) : null;
        if (img?.complete && img.naturalWidth) layers.push({ kind: 'image', el: img });
        else if (img && !img.complete) waiting = true;
        continue;
      }
      const v = this.assigned.get(c.id)?.el as HTMLVideoElement | undefined;
      if (v && v.readyState >= 2 && !v.seeking && v.videoWidth) layers.push({ kind: 'video', el: v });
      else if (!v && this.host.preparing(media)) message = 'Preparing preview…';
      else if (v && !v.error) waiting = true;
    }
    const now = performance.now();
    if (waiting) {
      if (!this.waitingSince) this.waitingSince = now;
      if (now - this.waitingSince < 500) {
        this.dirty = true;
        return;
      }
    }
    this.waitingSince = 0;

    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    // Same letterbox fit as the export (scale to fit, centered, never cropped).
    const fit = (src: CanvasImageSource, sw: number, sh: number) => {
      if (!sw || !sh) return;
      const s = Math.min(cw / sw, ch / sh);
      const dw = sw * s;
      const dh = sh * s;
      ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    };
    for (const layer of layers) {
      if (layer.kind === 'offline') {
        ctx.fillStyle = '#3a0010';
        ctx.fillRect(0, 0, cw, ch);
      } else if (layer.kind === 'image') fit(layer.el, layer.el.naturalWidth, layer.el.naturalHeight);
      else fit(layer.el, layer.el.videoWidth, layer.el.videoHeight);
    }

    if (message) {
      ctx.font = `${Math.round(22 * scale * (height / 1080))}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(message, cw / 2, ch / 2);
    }
    this.dirty = false;
    this.lastFrame = frame;
  }
}

let program: ProgramEngine | null = null;
export const programEngine = () => program;
export const setProgramEngine = (e: ProgramEngine | null) => {
  program = e;
};
