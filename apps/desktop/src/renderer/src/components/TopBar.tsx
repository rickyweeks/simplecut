import { FilePlus2, FolderOpen, Import, Keyboard, Redo2, Save, Scissors, Settings, Undo2, Upload } from 'lucide-react';
import { canRedo, canUndo } from '@simplecut/core';
import { redoCmd, undoCmd } from '../actions/edit';
import { importDialog, newProject, openProjectDialog, saveProject } from '../actions/project';
import { isDirty, useProject } from '../state/project';
import { useUi } from '../state/ui';
import { IconButton } from './common';

export function TopBar() {
  const name = useProject((s) => s.meta.name);
  const dirty = useProject(isDirty);
  const history = useProject((s) => s.history);
  const hasClips = useProject((s) => Object.keys(s.doc.timeline.clips).length > 0);
  const set = useUi((s) => s.set);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <Scissors size={13} strokeWidth={2.5} />
        </div>
        SimpleCut
      </div>
      <IconButton icon={<FilePlus2 size={17} />} label="New project" kbd="Ctrl+N" onClick={() => void newProject()} />
      <IconButton icon={<FolderOpen size={17} />} label="Open project" kbd="Ctrl+O" onClick={() => void openProjectDialog()} />
      <IconButton icon={<Save size={17} />} label="Save project" kbd="Ctrl+S" onClick={() => void saveProject()} testId="save" />
      <div className="topbar-sep" />
      <IconButton icon={<Import size={17} />} label="Import media" kbd="Ctrl+I" onClick={() => void importDialog()} />
      <div className="topbar-sep" />
      <IconButton icon={<Undo2 size={17} />} label="Undo" kbd="Ctrl+Z" onClick={undoCmd} disabled={!canUndo(history)} />
      <IconButton icon={<Redo2 size={17} />} label="Redo" kbd="Shift+Ctrl+Z" onClick={redoCmd} disabled={!canRedo(history)} />
      <div className="project-name" title={name}>
        <span>{name}</span>
        {dirty && <div className="dirty-dot" aria-label="Unsaved changes" />}
      </div>
      <div className="spacer" />
      <IconButton icon={<Keyboard size={17} />} label="Keyboard shortcuts (hold ? anywhere)" kbd="?" onClick={() => set({ shortcutsVisible: true })} />
      <IconButton icon={<Settings size={17} />} label="Settings" onClick={() => set({ dialog: 'settings' })} />
      <button
        type="button"
        className="btn primary big"
        data-tip="Export an MP4 ready for YouTube"
        data-kbd="Ctrl+M"
        data-testid="export-button"
        disabled={!hasClips}
        onClick={() => set({ dialog: 'export' })}
        style={{ marginLeft: 6 }}
      >
        <Upload size={15} strokeWidth={2.4} />
        Export for YouTube
      </button>
    </header>
  );
}
