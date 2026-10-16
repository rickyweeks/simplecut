import { useEffect } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { handleCloseRequest, importPaths, openProjectPath, startAutosave, startTitleSync } from './actions/project';
import { TooltipLayer, Toasts } from './components/common';
import { ExportDialog, RecoveryDialog, RelinkDialog, SettingsDialog, ShortcutSheet } from './components/Dialogs';
import { Inspector } from './components/Inspector';
import { MediaBin } from './components/MediaBin';
import { ProgramMonitor } from './components/ProgramMonitor';
import { SourceMonitor } from './components/SourceMonitor';
import { Timeline } from './components/timeline/Timeline';
import { TopBar } from './components/TopBar';
import { api } from './lib/api';
import { handleKeyDown, handleKeyUp } from './shortcuts';
import { startAssetListener } from './state/assets';
import { useUi } from './state/ui';

let started = false;

/** One-time app wiring: keyboard, autosave, window title, close prompt, launch file, crash recovery. */
function startApp(): void {
  if (started) return;
  started = true;
  startAssetListener();
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  startAutosave();
  startTitleSync();
  api.app.onCloseRequest(() => void handleCloseRequest());
  api.app.onOpenFile((p) => void openProjectPath(p));

  // Files dropped anywhere that isn't a specific drop zone are imported (and never
  // allowed to navigate the window away).
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (files.length) void importPaths(files);
  });

  void (async () => {
    const recoverable = await api.recovery.list();
    if (recoverable.length) {
      useUi.getState().set({ dialog: 'recovery' });
      return;
    }
    const file = await api.app.launchFile();
    if (file) await openProjectPath(file, { skipConfirm: true });
  })();
}

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
})();

export function App() {
  const dialog = useUi((s) => s.dialog);
  const shortcuts = useUi((s) => s.shortcutsVisible);
  const main = useDefaultLayout({ id: 'scut-main', storage });
  const top = useDefaultLayout({ id: 'scut-top', storage });

  useEffect(startApp, []);

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <div className="main-area">
          <Group orientation="vertical" id="scut-main" defaultLayout={main.defaultLayout} onLayoutChanged={main.onLayoutChanged} style={{ height: '100%' }}>
            <Panel id="top" defaultSize="50%" minSize="22%">
              <Group orientation="horizontal" id="scut-top" defaultLayout={top.defaultLayout} onLayoutChanged={top.onLayoutChanged} style={{ height: '100%' }}>
                <Panel id="bin" defaultSize="22%" minSize="12%">
                  <MediaBin />
                </Panel>
                <Separator />
                <Panel id="source" defaultSize="39%" minSize="18%">
                  <SourceMonitor />
                </Panel>
                <Separator />
                <Panel id="program" defaultSize="39%" minSize="18%">
                  <ProgramMonitor />
                </Panel>
              </Group>
            </Panel>
            <Separator />
            <Panel id="timeline" defaultSize="50%" minSize="25%">
              <Timeline />
            </Panel>
          </Group>
        </div>
        <Inspector />
      </div>
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'relink' && <RelinkDialog />}
      {dialog === 'recovery' && <RecoveryDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {shortcuts && <ShortcutSheet />}
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
