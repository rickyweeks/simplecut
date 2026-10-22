import {
  DEFAULT_DUCK_DB,
  FORMATS,
  bakeLut,
  clipSpeed,
  gradeKey,
  isIdentityTransform,
  isNeutralGrade,
  mediaPictureSize,
  pictureGeometry,
  sourceFrameAt,
  sourceSpan,
  transformOf,
  zoomScaleAt,
  audioTracks,
  audioTransitionGain,
  clipAt,
  clipEnd,
  clipGainAt,
  clipPlaySpans,
  dbToGain,
  duckGainAt,
  isTrackAudible,
  textAnimState,
  timelineDuration,
  trackGain,
  transitionFrameAt,
  videoTracks,
  type Clip,
  type CubeLut,
  type DuckRegion,
  type Frame,
  type MediaItem,
  type TextContent,
  type Timeline,
} from '@simplecut/core';
import { getPlayhead, setPlayhead, usePlayhead } from '../state/playhead';
import { drawTransformed } from '../render/picture';
import type { RenderedText } from '../text/renderText';
import { ColorProcessor } from './color';

/**
 * Program monitor playback: composites every visible video track onto a canvas and mixes
 * every audible audio track through Web Audio, in real time.
 *
 * The composite mirrors the export graph exactly: tracks are drawn bottom-up (V1 first,
 * higher tracks cover lower ones), each clip fitted (letterboxed) into the frame on black or
 * placed by its transform (core pictureGeometry), color-graded with the same baked LUT, and
 * timed by its speed (the source frame shown is the one FFmpeg's setpts + fps pick);
 * transitions, title animations and every audio gain (clip volume, fades, crossfades,
 * track volume, music ducking, master gain) come from the same core functions the export
 * uses, so what you hear and see is what you get.
 *
 * Media elements come from a small pool and are matched to clips each frame, preferring an
 * element already positioned near the needed time, so playing across a razor cut keeps the
 * same element running seamlessly. Upcoming clips are pre-seeked before they start.
 */

export interface EngineHost {
  /** The timeline to show (a live drag preview if one exists). */
  timeline(): Timeline;
  media(id: string): MediaItem | undefined;
  /** Playable picture URL (proxy or original), or null when nothing can be played yet. */
  url(media: MediaItem): string | null;
  /** Playable sound URL for a clip (e.g. its noise-reduced file). */
  audioUrl(clip: Clip, media: MediaItem): string | null;
  offline(mediaId: string): boolean;
  /** A proxy is being prepared and the original can't be shown. */
  preparing(media: MediaItem): boolean;
  /** Playback resolution factor (1, 0.5, 0.25). */
  scale(): number;
  /** The browser failed to decode this media's original file. */
  unplayable(media: MediaItem, url: string): void;
  /** A title drawn into a transparent full-frame canvas. */
  text(text: TextContent, width: number, height: number): RenderedText;
  /** Where dialogue is (the music track ducks under it). */
  duckRegions(): DuckRegion[];
  /** An imported LUT: the table, undefined while loading, null if it can't be read. */
  inputLut(path: string): CubeLut | null | undefined;
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
  /** First frame the clip is needed at (earlier than its start inside a transition). */
  from: Frame;
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
  private color = new ColorProcessor();
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
  /** Since when the current frame has been waiting for a decoder (0 = not waiting). */
  private waitingSince = 0;

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

  /** Clips each track needs now (including transition handles) and soon (pre-roll). */
  private collectNeeds(tl: Timeline, frame: Frame, forward: boolean): Need[] {
    const fps = tl.settings.fps;
    const needs: Need[] = [];
    const horizon = frame + PRELOAD_SEC * fps * Math.max(1, this.rate);
    const addTrack = (trackId: string, kind: SlotKind) => {
      const spans = [...clipPlaySpans(tl, trackId).values()];
      const active = spans.filter((s) => s.from <= frame && frame < s.to);
      for (const s of active) needs.push({ clip: s.clip, kind, active: true, from: s.from });
      if (!forward) return;
      for (const s of spans) {
        if (s.from <= frame || s.from > horizon) continue;
        // A clip that simply continues an active one (a razor cut) inherits its element.
        const continues = active.some(
          (a) =>
            a.clip.mediaId === s.clip.mediaId &&
            s.clip.start === clipEnd(a.clip) &&
            clipSpeed(s.clip) === clipSpeed(a.clip) &&
            Math.abs(s.clip.sourceIn - (a.clip.sourceIn + sourceSpan(a.clip, a.clip.duration))) < 1e-6,
        );
        if (!continues) needs.push({ clip: s.clip, kind, active: false, from: s.from });
      }
    };
    for (const t of videoTracks(tl)) if (!t.hidden) addTrack(t.id, 'video');
    for (const t of audioTracks(tl)) if (isTrackAudible(tl, t)) addTrack(t.id, 'audio');
    return needs.filter((n) => !n.clip.text);
  }

  /** Matches media elements to the clips that are (or are about to be) on screen, and drives them. */
  private sync(tl: Timeline, frame: Frame, exact: number, now: number): void {
    const fps = tl.settings.fps;
    const forward = this.playing && this.rate > 0;
    const needs = this.collectNeeds(tl, frame, forward);

    const urlFor = (n: Need): string | null => {
      const media = this.host.media(n.clip.mediaId);
      if (!media || media.kind === 'image' || this.host.offline(media.id)) return null;
      return n.kind === 'audio' ? this.host.audioUrl(n.clip, media) : this.host.url(media);
    };
    // Source time at a (fractional) timeline frame; +0.5 frame shows the frame the export's fps filter picks.
    const sourceSec = (clip: Clip, at: number) => Math.max(0, sourceFrameAt(clip, at) / fps);

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
      const target = sourceSec(n.clip, Math.max(frame, n.from));
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

    const regions = this.host.duckRegions();
    const depth = tl.duckDb ?? DEFAULT_DUCK_DB;
    this.master.gain.setTargetAtTime(dbToGain(tl.masterGainDb ?? 0), this.audio.currentTime, 0.02);

    for (const n of needs) {
      const s = next.get(n.clip.id);
      if (!s) continue;
      s.lastUsed = now;
      const { clip } = n;
      const el = s.el;
      if (!n.active) {
        // Pre-roll: park on the first frame the clip will be needed at.
        const t = sourceSec(clip, n.from + 0.5);
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - t) > 0.5 / fps) el.currentTime = t;
        if (s.gain) s.gain.gain.value = 0;
        continue;
      }
      if (s.gain) {
        const track = tl.tracks.find((t) => t.id === clip.trackId);
        let g = clipGainAt(clip, exact) * audioTransitionGain(tl, clip, exact) * (track ? trackGain(track) : 1);
        if (track?.music && depth < 0) g *= duckGainAt(regions, exact / fps, depth);
        s.gain.gain.setTargetAtTime(g, this.audio.currentTime, 0.01);
      }
      if (forward) {
        const target = sourceSec(clip, exact);
        const rate = this.rate * clipSpeed(clip);
        if (el.playbackRate !== rate) {
          el.preservesPitch = true;
          el.playbackRate = rate;
        }
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
        const t = sourceSec(clip, frame + 0.5);
        if (!el.seeking && Math.abs(el.currentTime - t) > (0.4 * clipSpeed(clip)) / fps) el.currentTime = t;
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
      slot.gain.gain.value = 0;
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

  private draw(tl: Timeline, frame: Frame): void {
    const { width: W, height: H } = FORMATS[tl.settings.format];
    const scale = this.host.scale();
    const cw = Math.max(2, Math.round(W * scale));
    const ch = Math.max(2, Math.round(H * scale));
    const fps = tl.settings.fps;

    // Decide what each track draws. If a video is still seeking/decoding, keep showing the
    // previous picture instead of flashing black (but never wait more than half a second).
    type Draw = { clip: Clip; alpha: number; dx: number };
    type Layer = { draws: Draw[]; color?: { css: string; alpha: number } };
    const layers: Layer[] = [];
    let message: string | null = null;
    let waiting = false;
    const check = (clip: Clip) => {
      if (clip.text) return;
      const media = this.host.media(clip.mediaId);
      if (!media) return;
      if (this.host.offline(media.id)) {
        message = `Media offline: ${media.name}`;
        return;
      }
      if (media.kind === 'image') {
        const url = this.host.url(media);
        const img = url ? this.image(url) : null;
        if (img && !img.complete) waiting = true;
        return;
      }
      const v = this.assigned.get(clip.id)?.el as HTMLVideoElement | undefined;
      if (!v && this.host.preparing(media)) message = 'Preparing preview…';
      else if (v && !v.error && (v.readyState < 2 || v.seeking || !v.videoWidth)) waiting = true;
    };
    for (const t of videoTracks(tl)) {
      if (t.hidden) continue;
      const tf = transitionFrameAt(tl, t.id, frame);
      if (tf?.mode === 'blend') {
        layers.push({
          draws:
            tf.type === 'dissolve'
              ? [
                  { clip: tf.a, alpha: 1, dx: 0 },
                  { clip: tf.b, alpha: tf.weight, dx: 0 },
                ]
              : [
                  { clip: tf.a, alpha: 1, dx: -tf.weight },
                  { clip: tf.b, alpha: 1, dx: 1 - tf.weight },
                ],
        });
      } else if (tf?.mode === 'fade') {
        layers.push(
          tf.color === 'none'
            ? { draws: [{ clip: tf.clip, alpha: tf.factor, dx: 0 }] }
            : { draws: [{ clip: tf.clip, alpha: 1, dx: 0 }], color: { css: tf.color === 'black' ? '#000' : '#fff', alpha: 1 - tf.factor } },
        );
      } else {
        const c = clipAt(tl, t.id, frame);
        if (c) layers.push({ draws: [{ clip: c, alpha: 1, dx: 0 }] });
      }
    }
    for (const l of layers) for (const d of l.draws) check(d.clip);
    const nowMs = performance.now();
    if (waiting) {
      if (!this.waitingSince) this.waitingSince = nowMs;
      if (nowMs - this.waitingSince < 500) {
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
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    // Same letterbox fit as the export (scale to fit, centered, never cropped).
    const fit = (src: CanvasImageSource, sw: number, sh: number, alpha: number, dx: number) => {
      if (!sw || !sh || alpha <= 0) return;
      const s = Math.min(cw / sw, ch / sh);
      const dw = sw * s;
      const dh = sh * s;
      ctx.globalAlpha = alpha;
      ctx.drawImage(src, (cw - dw) / 2 + dx * cw, (ch - dh) / 2, dw, dh);
      ctx.globalAlpha = 1;
    };
    const drawClip = ({ clip, alpha, dx }: Draw) => {
      if (clip.text) {
        const r = this.host.text(clip.text, W, H);
        const st = textAnimState(clip.text, frame - clip.start, clip.duration, fps);
        const a = alpha * st.alpha;
        if (a <= 0) return;
        const ax = clip.text.x * cw;
        const ay = clip.text.y * ch;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate((dx + st.dx) * cw + ax * (1 - st.scale), ay * (1 - st.scale));
        ctx.scale(st.scale, st.scale);
        ctx.drawImage(r.canvas, 0, 0, cw, ch);
        ctx.restore();
        return;
      }
      const media = this.host.media(clip.mediaId);
      if (!media) return;
      if (this.host.offline(media.id)) {
        ctx.fillStyle = '#3a0010';
        ctx.fillRect(0, 0, cw, ch);
        return;
      }
      let src: CanvasImageSource | null = null;
      let sw = 0;
      let sh = 0;
      if (media.kind === 'image') {
        const url = this.host.url(media);
        const img = url ? this.image(url) : null;
        if (img?.complete && img.naturalWidth) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
      } else {
        const v = this.assigned.get(clip.id)?.el as HTMLVideoElement | undefined;
        if (v && v.readyState >= 2 && v.videoWidth) [src, sw, sh] = [v, v.videoWidth, v.videoHeight];
      }
      if (!src) return;
      const k = cw / W;
      const identity = isIdentityTransform(clip.transform);
      const { w: mw, h: mh } = mediaPictureSize(media);
      const g = identity ? null : pictureGeometry(transformOf(clip), mw, mh, W, H, zoomScaleAt(transformOf(clip), frame - clip.start, clip.duration));
      // Color: grade the picture at the size it is drawn, through the same LUT the export uses.
      const grade = clip.color;
      if (grade && !isNeutralGrade(grade) && this.color.available) {
        const input = grade.lut ? this.host.inputLut(grade.lut.path) : null;
        if (!grade.lut || input) {
          const s = g ? Math.min(1, 4096 / Math.max(g.pw * k, g.ph * k)) : 1;
          const tw = g ? g.pw * k * s : Math.min(cw / sw, ch / sh) * sw;
          const th = g ? g.ph * k * s : Math.min(cw / sw, ch / sh) * sh;
          const out = this.color.process(src as TexImageSource, tw, th, gradeKey(grade), () => bakeLut(grade, input));
          if (out) [src, sw, sh] = [out, out.width, out.height];
        }
      }
      if (g) drawTransformed(ctx, src, sw, sh, g, k, W, dx, alpha);
      else fit(src, sw, sh, alpha, dx);
    };
    for (const layer of layers) {
      for (const d of layer.draws) drawClip(d);
      if (layer.color && layer.color.alpha > 0) {
        // Dips color the whole frame, like the export's full-frame color layer.
        ctx.globalAlpha = layer.color.alpha;
        ctx.fillStyle = layer.color.css;
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalAlpha = 1;
      }
    }

    if (message) {
      ctx.font = `${Math.round(22 * scale * (H / 1080))}px "Segoe UI", sans-serif`;
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
