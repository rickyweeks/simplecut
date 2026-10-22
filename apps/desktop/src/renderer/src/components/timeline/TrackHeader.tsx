import { memo } from 'react';
import { Eye, EyeOff, Lock, LockOpen, Music } from 'lucide-react';
import { setMusicTrack } from '../../actions/music';
import { setTargetTrack, updateTrack, type Track, type TrackFlags } from '@simplecut/core';
import { getTimeline, useProject } from '../../state/project';

function commit(label: string, fn: (tl: ReturnType<typeof getTimeline>) => ReturnType<typeof getTimeline>) {
  useProject.getState().commitTimeline(label, fn(getTimeline()));
}

/**
 * Track controls: source patching target (where insert/overwrite lands), then
 * hide (video) or mute/solo (audio), then lock. All one click, nothing hidden in menus.
 */
export const TrackHeader = memo(function TrackHeader({ track, label, targeted }: { track: Track; label: string; targeted: boolean }) {
  const flag = (patch: TrackFlags, what: string) => commit(what, (tl) => updateTrack(tl, track.id, patch));
  return (
    <div className={`track-header${track.locked ? ' locked' : ''}`} onPointerDown={(e) => e.stopPropagation()} data-testid={`track-${label}`}>
      <button
        type="button"
        className={`track-target ${track.kind}${targeted ? ' on' : ''}`}
        data-tip={
          targeted
            ? `Target: insert/overwrite places ${track.kind === 'video' ? 'video' : 'audio'} on ${label}. Click to turn off.`
            : `Make ${label} the target for insert/overwrite`
        }
        onClick={() => commit(`Target ${label}`, (tl) => setTargetTrack(tl, track.kind, targeted ? null : track.id))}
        aria-pressed={targeted}
      >
        {label}
      </button>
      {track.captions && (
        <span className="track-badge" data-tip="Captions track: auto captions go here, and export as .srt">
          CC
        </span>
      )}
      <div className="grow" />
      {track.kind === 'video' ? (
        <button
          type="button"
          className={`track-flag hide${track.hidden ? ' on' : ''}`}
          data-tip={track.hidden ? `Show ${label} in the output` : `Hide ${label} from the output`}
          onClick={() => flag({ hidden: !track.hidden }, track.hidden ? `Show ${label}` : `Hide ${label}`)}
          aria-pressed={track.hidden}
        >
          {track.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={`track-flag music${track.music ? ' on' : ''}`}
            data-tip={track.music ? `${label} is the music track (beats, snapping, ducks under dialogue). Click to turn off.` : `Make ${label} the music track`}
            onClick={() => setMusicTrack(track.id, !track.music)}
            aria-pressed={!!track.music}
          >
            <Music size={12} />
          </button>
          <button
            type="button"
            className={`track-flag mute${track.muted ? ' on' : ''}`}
            data-tip={track.muted ? `Unmute ${label}` : `Mute ${label}`}
            onClick={() => flag({ muted: !track.muted }, track.muted ? `Unmute ${label}` : `Mute ${label}`)}
            aria-pressed={track.muted}
          >
            M
          </button>
          <button
            type="button"
            className={`track-flag solo${track.solo ? ' on' : ''}`}
            data-tip={track.solo ? `Unsolo ${label}` : `Solo ${label} (hear only soloed tracks)`}
            onClick={() => flag({ solo: !track.solo }, track.solo ? `Unsolo ${label}` : `Solo ${label}`)}
            aria-pressed={track.solo}
          >
            S
          </button>
        </>
      )}
      <button
        type="button"
        className={`track-flag lock${track.locked ? ' on' : ''}`}
        data-tip={track.locked ? `Unlock ${label}` : `Lock ${label} (no edit can change it)`}
        onClick={() => flag({ locked: !track.locked }, track.locked ? `Unlock ${label}` : `Lock ${label}`)}
        aria-pressed={track.locked}
      >
        {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
      </button>
    </div>
  );
});
