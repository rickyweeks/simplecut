import { memo } from 'react';
import { Group, Link2Off } from 'lucide-react';
import type { Clip, MediaItem } from '@simplecut/core';
import type { MediaAssets } from '../../state/assets';
import { Thumbnails } from './Thumbnails';
import { WaveformCanvas } from './Waveform';

const HEAD_H = 16;

export const ClipView = memo(function ClipView(props: {
  clip: Clip;
  media?: MediaItem;
  assets?: MediaAssets;
  offline: boolean;
  selected: boolean;
  linked: boolean;
  px: number;
  fps: number;
  /** Visible frame range of the timeline (for drawing only what is on screen). */
  viewFrom: number;
  viewTo: number;
  rowHeight: number;
}) {
  const { clip, media, assets, px, fps } = props;
  const x = clip.start * px;
  const w = Math.max(2, clip.duration * px);
  const fromPx = Math.max(0, props.viewFrom * px - x);
  const toPx = Math.min(w, props.viewTo * px - x);
  const bodyH = props.rowHeight - 6 - HEAD_H;
  const pxPerSec = px * fps;
  const sourceSec = clip.sourceIn / fps;
  // Show the "unlinked" badge only where it is informative: media that has both streams.
  const showUnlinked = !props.linked && !!media?.hasVideo && !!media?.hasAudio;

  return (
    <div
      className={`clip ${clip.kind}${props.selected ? ' selected' : ''}${props.offline ? ' offline' : ''}`}
      style={{ left: x, width: w }}
      data-clip-id={clip.id}
      data-testid="clip"
    >
      <div className="clip-head">
        {clip.groupId && <Group size={11} />}
        {showUnlinked && <Link2Off size={11} />}
        <span>{media?.name ?? 'Missing media'}</span>
      </div>
      <div className="clip-body">
        {!props.offline && toPx > fromPx && clip.kind === 'video' && media?.kind === 'video' && assets?.thumbs && assets.thumbs.meta.count > 0 && (
          <Thumbnails
            dir={assets.thumbs.dir}
            meta={assets.thumbs.meta}
            aspect={media.width && media.height ? media.width / media.height : 16 / 9}
            height={bodyH}
            clipSourceSec={sourceSec}
            pxPerSec={pxPerSec}
            fromPx={fromPx}
            toPx={toPx}
          />
        )}
        {!props.offline && clip.kind === 'video' && media?.kind === 'image' && assets?.poster && (
          <img src={assets.poster} alt="" draggable={false} style={{ left: 0, width: Math.round(bodyH * (media.width / Math.max(1, media.height))) }} />
        )}
        {!props.offline && toPx > fromPx && clip.kind === 'audio' && assets?.waveform && (
          <WaveformCanvas
            peaks={assets.waveform}
            startSec={sourceSec + fromPx / pxPerSec}
            durationSec={(toPx - fromPx) / pxPerSec}
            width={Math.ceil(toPx - fromPx)}
            height={bodyH}
            color="rgba(79,224,164,0.85)"
            style={{ left: fromPx }}
          />
        )}
      </div>
      {props.offline && <div className="clip-offline-label">Media offline</div>}
      {w >= 12 && (
        <>
          <div className="clip-edge start" data-edge="start" />
          <div className="clip-edge end" data-edge="end" />
        </>
      )}
    </div>
  );
});
