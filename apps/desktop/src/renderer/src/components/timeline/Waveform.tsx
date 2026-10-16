import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { WAVEFORM_PEAKS_PER_SECOND } from '@simplecut/core';

/**
 * Draws a symmetric waveform for a span of source time. Peaks are stored one per 10 ms;
 * each pixel column shows the loudest peak it covers, with a gentle curve so quiet speech
 * is still visible.
 */
export const WaveformCanvas = memo(function WaveformCanvas(props: {
  peaks: Uint8Array;
  startSec: number;
  durationSec: number;
  /** CSS pixels; omitted = fill the parent's width. */
  width?: number;
  height: number;
  color: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [measured, setMeasured] = useState(0);
  const width = props.width ?? measured;

  useLayoutEffect(() => {
    if (props.width != null || !ref.current?.parentElement) return;
    const parent = ref.current.parentElement;
    const ro = new ResizeObserver(() => setMeasured(parent.clientWidth));
    ro.observe(parent);
    setMeasured(parent.clientWidth);
    return () => ro.disconnect();
  }, [props.width]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || width < 1) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.ceil(width * dpr);
    const h = Math.ceil(props.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = props.color;
    const { peaks } = props;
    const perPx = (props.durationSec * WAVEFORM_PEAKS_PER_SECOND) / w;
    const start = props.startSec * WAVEFORM_PEAKS_PER_SECOND;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(start + x * perPx);
      const i1 = Math.max(i0 + 1, Math.floor(start + (x + 1) * perPx));
      let peak = 0;
      for (let i = Math.max(0, i0); i < i1 && i < peaks.length; i++) if (peaks[i]! > peak) peak = peaks[i]!;
      if (!peak) continue;
      const amp = Math.pow(peak / 255, 0.65) * (mid - 1);
      ctx.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
    }
  }, [props.peaks, props.startSec, props.durationSec, width, props.height, props.color]);

  return <canvas ref={ref} style={{ width, height: props.height, display: 'block', ...props.style }} />;
});
