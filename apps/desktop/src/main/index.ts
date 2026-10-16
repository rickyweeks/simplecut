import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { IMPORT_EXTENSIONS, PROJECT_EXTENSION, type MediaInfo } from '@simplecut/core';
import { IPC, type ConfirmOptions, type ExportStartRequest } from '../shared/api';
import { encoderDetector, encoderInfo } from './encoders';
import { cancelExport, startExport } from './exporter';
import { binariesPresent, killAll } from './ffmpeg';
import { prepareMedia, prober } from './media';
import { registerMediaProtocol, registerSchemePrivileges } from './protocol';
import { findInFolder, projectStorage, recovery } from './storage';

app.setName('SimpleCut');
registerSchemePrivileges();

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
let win: BrowserWindow | null = null;
let allowClose = false;

/** A .scut path from the command line (Explorer double-click), if any. */
function projectArg(argv: string[]): string | null {
  const p = argv.slice(1).find((a) => a.toLowerCase().endsWith(PROJECT_EXTENSION) && existsSync(a));
  return p ?? null;
}
let launchFile = projectArg(process.argv);

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = projectArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (file) win.webContents.send(IPC.appOpenFile, file);
    }
  });
}

function createWindow(): void {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#000000',
    title: 'SimpleCut',
    // Pure black, frameless-looking title bar that keeps the native Windows controls.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#d8d8d8', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win?.webContents.send(IPC.appCloseRequest);
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win?.webContents.toggleDevTools();
    }
  });

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  const parent = () => win ?? undefined;
  const mediaFilter = { name: 'Video, audio and images', extensions: IMPORT_EXTENSIONS.map((e) => e.slice(1)) };
  const projectFilter = { name: 'SimpleCut project', extensions: [PROJECT_EXTENSION.slice(1)] };

  ipcMain.handle(IPC.dialogOpenMedia, async () => {
    const r = await dialog.showOpenDialog(parent()!, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: [mediaFilter] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle(IPC.dialogOpenProject, async () => {
    const r = await dialog.showOpenDialog(parent()!, { title: 'Open project', properties: ['openFile'], filters: [projectFilter] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.dialogSaveProject, async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(parent()!, { title: 'Save project', defaultPath: `${defaultName}${PROJECT_EXTENSION}`, filters: [projectFilter] });
    return r.canceled ? null : (r.filePath ?? null);
  });
  ipcMain.handle(IPC.dialogExportVideo, async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(parent()!, {
      title: 'Export for YouTube',
      defaultPath: join(app.getPath('videos'), `${defaultName}.mp4`),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return r.canceled ? null : (r.filePath ?? null);
  });
  ipcMain.handle(IPC.dialogLocateMedia, async (_e, fileName: string) => {
    const r = await dialog.showOpenDialog(parent()!, { title: `Locate "${fileName}"`, properties: ['openFile'], filters: [mediaFilter, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.dialogConfirm, async (_e, o: ConfirmOptions) => {
    const r = await dialog.showMessageBox(parent()!, { type: 'question', message: o.message, detail: o.detail, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId, noLink: true });
    return r.response;
  });

  ipcMain.handle(IPC.projectRead, (_e, path: string) => projectStorage.readText(path));
  ipcMain.handle(IPC.projectWrite, (_e, path: string, text: string) => projectStorage.writeText(path, text));
  ipcMain.handle(IPC.projectExists, (_e, paths: string[]) => projectStorage.exists(paths));
  ipcMain.handle(IPC.projectFindInFolder, (_e, folder: string, names: string[]) => findInFolder(folder, names));

  ipcMain.handle(IPC.recoveryWrite, (_e, id: string, text: string, meta: { name: string; projectPath: string | null }) => recovery.write(id, text, meta));
  ipcMain.handle(IPC.recoveryList, () => recovery.list());
  ipcMain.handle(IPC.recoveryRead, (_e, id: string) => recovery.read(id));
  ipcMain.handle(IPC.recoveryClear, (_e, id: string) => recovery.clear(id));

  ipcMain.handle(IPC.mediaProbe, (_e, path: string) => prober.probe(path));
  ipcMain.handle(IPC.mediaPrepare, (_e, path: string, info: MediaInfo, opts?: { forceProxy?: boolean }) => prepareMedia(path, info, opts));

  ipcMain.handle(IPC.exportEncoders, () => encoderInfo());
  ipcMain.handle(IPC.exportStart, (e, req: ExportStartRequest) => startExport(req, (p) => e.sender.send(IPC.exportProgress, p)));
  ipcMain.handle(IPC.exportCancel, () => cancelExport());

  ipcMain.on(IPC.shellShowItem, (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.on(IPC.appSetTitle, (_e, title: string) => win?.setTitle(title));
  ipcMain.on(IPC.appConfirmClose, () => {
    allowClose = true;
    win?.close();
  });
  ipcMain.handle(IPC.appLaunchFile, () => {
    const f = launchFile;
    launchFile = null;
    return f;
  });
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  if (!binariesPresent()) {
    dialog.showErrorBox('SimpleCut', 'FFmpeg is missing. Run "pnpm install" (or "pnpm --filter @simplecut/desktop prepare-bin") and start again.');
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);
  registerMediaProtocol();
  registerIpc();
  createWindow();
  // Warm up hardware encoder detection so the first export or proxy doesn't wait for it.
  void encoderDetector.detect();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => killAll());
