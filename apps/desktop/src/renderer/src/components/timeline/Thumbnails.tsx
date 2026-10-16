import { memo } from 'react';
import type { ThumbnailMeta } from '../../../../shared/api';
import { api } from '../../lib/api';

/**
 * Filmstrip for the visible part of a video clip: one thumbnail every `thumbWidth` pixels,
 * each showing the source frame at that position.
 */
export const Thumbnails = memo(function Thumbnails(props: {
  dir: string;
  meta: ThumbnailMeta;
  aspect: number;
  height: number;
  /** Source time (seconds) at x = 0 of the clip. */
  clipSourceSec: number;
  /** Pixels per second at the current zoom. */
  pxPerSec: number;
  /** Visible part of the clip, in clip-local pixels. */
  fromPx: number;
  toPx: number;
}) {
  const thumbW = Math.max(16, Math.round(props.height * props.aspect));
  const first = Math.floor(props.fromPx / thumbW);
  const last = Math.ceil(props.toPx / thumbW);
  const imgs = [];
  for (let i = Math.max(0, first); i <= last; i++) {
    const x = i * thumbW;
    const sec = props.clipSourceSec + x / props.pxPerSec;
    const idx = Math.min(props.meta.count, Math.max(1, Math.floor(sec / props.meta.intervalSec) + 1));
    const file = `${props.dir}\\${String(idx).padStart(5, '0')}.jpg`;
    imgs.push(<img key={i} src={api.mediaUrl(file)} alt="" draggable={false} style={{ left: x, width: thumbW }} />);
  }
  return <>{imgs}</>;
});
