import { memo } from 'react';
import { AudioWaveform, Group, Link2Off, Music, Type, Wand2 } from 'lucide-react';
import { MAX_VOLUME_DB, MIN_VOLUME_DB, beatFramesInClip, effectiveFades, type Clip, type MediaItem } from '@simplecut/core';
import type { MediaAssets } from '../../state/assets';
import { Thumbnails } from './Thumbnails';
import { WaveformCanvas } from './Waveform';

const HEAD_H = 16;

/** Vertical position (0 = top, 1 = bottom of the clip body) of a volume in dB. 0 dB sits at 30 %. */
export function volumeToY(db: number): number {
  if (db >= 0) return 0.3 - 0.3 * (db / MAX_VOLUME_DB);
  return 0.3 + 0.7 * (db / MIN_VOLUME_DB);
}

export function yToVolume(y: number): number {
  const v = y <= 0.3 ? ((0.3 - y) / 0.3) * MAX_VOLUME_DB : ((y - 0.3) / 0.7) * MIN_VOLUME_DB;
  return Math.round(Math.min(MAX_VOLUME_DB, Math.max(MIN_VOLUME_DB, v)) * 2) / 2;
}

export const ClipView = memo(function ClipView(props: {
  clip: Clip;
  media?: MediaItem;
  assets?: MediaAssets;
  offline: boolean;
  selected: boolean;
  linked: boolean;
  onMusicTrack: boolean;
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
  const isText = !!clip.text;
  // Show the "unlinked" badge only where it is informative: media that has both streams.
  const showUnlinked = !props.linked && !!media?.hasVideo && !!media?.hasAudio;
  const { fadeIn, fadeOut } = effectiveFades(clip);
  const volY = volumeToY(clip.volumeDb ?? 0) * bodyH;
  // Beat ticks on music clips: only the visible ones, and only bars when beats get crowded.
  const downbeats = new Set(props.onMusicTrack && media?.beats ? beatFramesInClip(media.beats, clip, fps, 'downbeats') : []);
  const beatSpacingPx = media?.beats?.bpm ? (60 / media.beats.bpm) * fps * px : 0;
  const beats = (props.onMusicTrack && media?.beats ? beatFramesInClip(media.beats, clip, fps) : []).filter((f) => {
    const bx = (f - clip.start) * px;
    return bx >= fromPx && bx <= toPx && (beatSpacingPx >= 5 || downbeats.has(f));
  });

  return (
    <div
      className={`clip ${clip.kind}${isText ? ' text' : ''}${props.selected ? ' selected' : ''}${props.offline ? ' offline' : ''}`}
      style={{ left: x, width: w }}
      data-clip-id={clip.id}
      data-testid="clip"
    >
      <div className="clip-head">
        {isText && <Type size={11} />}
        {props.onMusicTrack && <Music size={11} />}
        {clip.groupId && <Group size={11} />}
        {showUnlinked && <Link2Off size={11} />}
        {clip.denoise ? <Wand2 size={11} aria-label="Noise reduction" /> : null}
        <span>{isText ? clip.text!.content.split('\n')[0] || 'Title' : (media?.name ?? 'Missing media')}</span>
        {clip.kind === 'audio' && clip.volumeDb ? <span className="clip-db">{clip.volumeDb > 0 ? '+' : ''}{clip.volumeDb} dB</span> : null}
      </div>
      <div className="clip-body">
        {isText && <div className="clip-text-preview" style={{ fontFamily: `"${clip.text!.font}"` }}>{clip.text!.content}</div>}
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
            color={props.onMusicTrack ? 'rgba(125,200,255,0.8)' : 'rgba(79,224,164,0.85)'}
            style={{ left: fromPx }}
          />
        )}
        {clip.kind === 'audio' && !props.offline && (
          <>
            {(fadeIn > 0 || fadeOut > 0) && (
              <svg className="clip-fades" width={w} height={bodyH}>
                {fadeIn > 0 && <polygon points={`0,0 ${fadeIn * px},0 0,${bodyH}`} />}
                {fadeOut > 0 && <polygon points={`${w},0 ${w - fadeOut * px},0 ${w},${bodyH}`} />}
              </svg>
            )}
            <div className="clip-volume" style={{ top: volY }} data-vol data-tip="Drag up or down to change the volume" />
            {w > 30 && (
              <>
                <div className="fade-handle in" style={{ left: Math.max(0, fadeIn * px) }} data-fade="in" data-tip="Drag to fade in" />
                <div className="fade-handle out" style={{ right: Math.max(0, fadeOut * px) }} data-fade="out" data-tip="Drag to fade out" />
              </>
            )}
          </>
        )}
        {beats.map((f) => (
          <div key={f} className={`beat-tick${downbeats.has(f) ? ' bar' : ''}`} style={{ left: (f - clip.start) * px }} />
        ))}
      </div>
      {props.offline && <div className="clip-offline-label">Media offline</div>}
      {w >= 12 && (
        <>
          <div className="clip-edge start" data-edge="start" />
          <div className="clip-edge end" data-edge="end" />
        </>
      )}
      {clip.kind === 'audio' && media?.hasAudio && !assets?.waveform && w > 40 && (
        <AudioWaveform className="clip-wave-pending" size={14} />
      )}
    </div>
  );
});
