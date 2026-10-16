import { memo, useState } from 'react';
import { AudioLines, Film, FolderInput, Image as ImageIcon, Import } from 'lucide-react';
import { formatDuration, needsProxy, type MediaItem } from '@simplecut/core';
import { importDialog, importPaths } from '../actions/project';
import { api, beginDrag, endDrag } from '../lib/api';
import { useAssets, type MediaAssets } from '../state/assets';
import { useProject } from '../state/project';
import { useSource } from '../state/source';
import { useUi } from '../state/ui';
import { IconButton } from './common';

export function osFilePaths(e: React.DragEvent): string[] {
  return [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
}

export const isOsFileDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

export function MediaBin() {
  const media = useProject((s) => s.doc.media);
  const focused = useUi((s) => s.focus === 'bin');
  const [dropping, setDropping] = useState(false);
  const items = Object.values(media);

  return (
    <section
      className={`panel${focused ? ' focused' : ''}`}
      onPointerDown={() => useUi.getState().set({ focus: 'bin' })}
      onDragOver={(e) => {
        if (!isOsFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!isOsFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        void importPaths(osFilePaths(e));
      }}
      data-testid="media-bin"
    >
      <div className="panel-header">
        <span className="panel-title">Media</span>
        <span className="panel-subtitle">{items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : ''}</span>
        <div className="grow" />
        <IconButton icon={<Import size={16} />} label="Import media" kbd="Ctrl+I" onClick={() => void importDialog()} small />
      </div>
      <div className={`panel-body${dropping ? ' drop-target' : ''}`}>
        {items.length === 0 ? (
          <div className="empty">
            <div>
              <FolderInput className="empty-icon" size={28} />
              <h3>Drag videos here to start</h3>
              Or import MP4, MOV, MKV, WebM, MP3, WAV, AAC, PNG and JPG files.
              <br />
              <button type="button" className="btn" onClick={() => void importDialog()}>
                <Import size={14} /> Import media
              </button>
            </div>
          </div>
        ) : (
          <div className="bin-grid">
            {items.map((m) => (
              <BinItemHost key={m.id} media={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BinItemHost({ media }: { media: MediaItem }) {
  const assets = useAssets((s) => s.byPath[media.path]);
  const offline = useAssets((s) => !!s.offline[media.id]);
  const selected = useUi((s) => s.selection.mediaIds.includes(media.id));
  const inSource = useSource((s) => s.mediaId === media.id);
  return <BinItem media={media} assets={assets} offline={offline} selected={selected || inSource} />;
}

const BinItem = memo(function BinItem({ media, assets, offline, selected }: { media: MediaItem; assets?: MediaAssets; offline: boolean; selected: boolean }) {
  const proxy = assets?.proxy;
  const optimizing = !offline && (needsProxy(media) || assets?.originalUnplayable) && proxy?.state !== 'ready' && proxy?.state !== 'failed';
  const KindIcon = media.kind === 'audio' ? AudioLines : media.kind === 'image' ? ImageIcon : Film;

  return (
    <div
      className={`bin-item${selected ? ' selected' : ''}`}
      draggable={!offline}
      data-testid="bin-item"
      data-media-id={media.id}
      data-tip={`${media.name} — double-click to open in the Source monitor, or drag to the timeline`}
      onClick={(e) => {
        const ui = useUi.getState();
        const ids = e.ctrlKey || e.shiftKey ? [...new Set([...ui.selection.mediaIds, media.id])] : [media.id];
        ui.select({ mediaIds: ids });
      }}
      onDoubleClick={() => {
        useSource.getState().load(media.id);
        useUi.getState().set({ focus: 'source' });
      }}
      onDragStart={(e) => beginDrag(e, { mediaId: media.id, inSec: 0, outSec: null, video: true, audio: true })}
      onDragEnd={endDrag}
    >
      <div className="bin-thumb">
        {assets?.poster ? <img src={assets.poster} alt="" draggable={false} /> : <KindIcon size={26} strokeWidth={1.5} />}
        <div className="bin-kind">
          <KindIcon size={12} />
        </div>
        {media.kind !== 'image' && <div className="bin-duration">{formatDuration(media.durationSec)}</div>}
        {optimizing && (
          <div className="bin-status" data-tip="Making a lightweight copy for smooth editing. Your export always uses the original.">
            Optimizing for editing {Math.round((proxy?.progress ?? 0) * 100)}%
            <div className="bar">
              <div style={{ width: `${Math.round((proxy?.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {offline && <div className="bin-offline">Media offline</div>}
      </div>
      <div className="bin-name">{media.name}</div>
    </div>
  );
});
