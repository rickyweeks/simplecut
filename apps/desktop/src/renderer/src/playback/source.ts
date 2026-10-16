import { effectiveFps, type MediaItem } from '@simplecut/core';
import { getDoc } from '../state/project';
import { useSource } from '../state/source';
import { nextJklRate } from './engine';

/**
 * Source monitor transport. Works on the frame grid the clip will be edited on (the
 * timeline rate, or the rate the timeline will adopt when this is its first clip), so
 * marks land exactly on frames the timeline can represent.
 */
class SourcePlayer {
  private el: HTMLMediaElement | null = null;
  private raf = 0;
  private reverseTimer: ReturnType<typeof setInterval> | null = null;

  attach(el: HTMLMediaElement | null): void {
    this.stopLoops();
    this.el = el;
    if (el) {
      const { timeSec } = useSource.getState();
      const seekWhenReady = () => this.seekFrame(this.frameOf(timeSec));
      if (el.readyState >= 1) seekWhenReady();
      else el.addEventListener('loadedmetadata', seekWhenReady, { once: true });
    }
  }

  media(): MediaItem | undefined {
    const id = useSource.getState().mediaId;
    return id ? getDoc().media[id] : undefined;
  }

  fps(): number {
    return effectiveFps(getDoc().timeline, this.media());
  }

  frameOf(sec: number): number {
    return Math.max(0, Math.floor(sec * this.fps() + 1e-6));
  }

  /** Last frame index of the media. */
  lastFrame(): number {
    const m = this.media();
    if (!m || m.kind === 'image') return 0;
    return Math.max(0, Math.floor(m.durationSec * this.fps() + 1e-6) - 1);
  }

  currentFrame(): number {
    return this.frameOf(useSource.getState().timeSec);
  }

  seekFrame(frame: number): void {
    const f = Math.min(Math.max(0, Math.round(frame)), this.lastFrame());
    const fps = this.fps();
    useSource.getState().set({ timeSec: f / fps });
    // Seek to mid-frame so the decoder never rounds to the neighbouring frame.
    if (this.el && this.el.readyState >= 1) this.el.currentTime = (f + 0.5) / fps;
  }

  seekSec(sec: number): void {
    this.seekFrame(this.frameOf(sec));
  }

  get playing(): boolean {
    return useSource.getState().playing;
  }

  play(rate = 1): void {
    if (rate === 0) return this.pause();
    const el = this.el;
    if (!el || this.media()?.kind === 'image') return;
    this.stopLoops();
    useSource.getState().set({ playing: true, rate });
    if (rate > 0) {
      if (this.currentFrame() >= this.lastFrame()) this.seekFrame(0);
      el.playbackRate = rate;
      void el.play().catch(() => {});
      const loop = () => {
        if (!this.el || this.el.paused) return;
        useSource.getState().set({ timeSec: this.el.currentTime });
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
      el.onended = () => this.pause();
    } else {
      // Media elements can't play backwards: step frames instead.
      el.pause();
      const fps = this.fps();
      this.reverseTimer = setInterval(() => {
        const f = this.currentFrame();
        if (f <= 0) return this.pause();
        this.seekFrame(f - 1);
      }, 1000 / (fps * Math.abs(rate)));
    }
  }

  pause(): void {
    this.stopLoops();
    if (this.el && !this.el.paused) this.el.pause();
    const s = useSource.getState();
    if (s.playing) s.set({ playing: false, rate: 0 });
    if (this.el) this.seekFrame(this.frameOf(this.el.currentTime));
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play(1);
  }

  jkl(key: 'j' | 'k' | 'l'): void {
    const s = useSource.getState();
    this.play(nextJklRate(s.playing ? s.rate : 0, key));
  }

  step(frames: number): void {
    if (this.playing) this.pause();
    this.seekFrame(this.currentFrame() + frames);
  }

  markIn(): void {
    const s = useSource.getState();
    const inSec = this.currentFrame() / this.fps();
    s.set({ inSec, outSec: s.outSec != null && s.outSec <= inSec ? null : s.outSec });
  }

  /** Out is inclusive: the frame under the playhead is part of the selection. */
  markOut(): void {
    const s = useSource.getState();
    const outSec = (this.currentFrame() + 1) / this.fps();
    s.set({ outSec, inSec: s.inSec != null && s.inSec >= outSec ? null : s.inSec });
  }

  clearMarks(): void {
    useSource.getState().set({ inSec: null, outSec: null });
  }

  goToIn(): void {
    const { inSec } = useSource.getState();
    this.seekSec(inSec ?? 0);
  }

  goToOut(): void {
    const { outSec } = useSource.getState();
    if (outSec == null) this.seekFrame(this.lastFrame());
    else this.seekFrame(Math.round(outSec * this.fps()) - 1);
  }

  private stopLoops(): void {
    cancelAnimationFrame(this.raf);
    if (this.reverseTimer) clearInterval(this.reverseTimer);
    this.reverseTimer = null;
  }
}

export const sourcePlayer = new SourcePlayer();
