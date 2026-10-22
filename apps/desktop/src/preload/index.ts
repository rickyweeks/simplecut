import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, mediaUrlFor, type ScutApi } from '../shared/api';

/** Subscribes to a main-process event and returns an unsubscribe function. */
function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: ScutApi = {
  versions: { app: '0.1.0', electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '' },
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl: (path) => mediaUrlFor(path),

  dialogs: {
    openMedia: () => ipcRenderer.invoke(IPC.dialogOpenMedia),
    openProject: () => ipcRenderer.invoke(IPC.dialogOpenProject),
    saveProject: (defaultName) => ipcRenderer.invoke(IPC.dialogSaveProject, defaultName),
    exportVideo: (defaultName) => ipcRenderer.invoke(IPC.dialogExportVideo, defaultName),
    locateMedia: (fileName) => ipcRenderer.invoke(IPC.dialogLocateMedia, fileName),
    confirm: (opts) => ipcRenderer.invoke(IPC.dialogConfirm, opts),
  },

  project: {
    read: (path) => ipcRenderer.invoke(IPC.projectRead, path),
    write: (path, text) => ipcRenderer.invoke(IPC.projectWrite, path, text),
    exists: (paths) => ipcRenderer.invoke(IPC.projectExists, paths),
    findInFolder: (folder, names) => ipcRenderer.invoke(IPC.projectFindInFolder, folder, names),
  },

  recovery: {
    write: (id, text, meta) => ipcRenderer.invoke(IPC.recoveryWrite, id, text, meta),
    list: () => ipcRenderer.invoke(IPC.recoveryList),
    read: (id) => ipcRenderer.invoke(IPC.recoveryRead, id),
    clear: (id) => ipcRenderer.invoke(IPC.recoveryClear, id),
  },

  media: {
    probe: (path) => ipcRenderer.invoke(IPC.mediaProbe, path),
    prepare: (path, info, opts) => ipcRenderer.invoke(IPC.mediaPrepare, path, info, opts),
    onAsset: (listener) => listen(IPC.mediaAsset, listener),
    analyzeBeats: (path) => ipcRenderer.invoke(IPC.mediaBeats, path),
    denoise: (path, info, strength) => ipcRenderer.invoke(IPC.mediaDenoise, path, info, strength),
  },

  exporter: {
    encoders: () => ipcRenderer.invoke(IPC.exportEncoders),
    start: (req) => ipcRenderer.invoke(IPC.exportStart, req),
    cancel: () => ipcRenderer.invoke(IPC.exportCancel),
    onProgress: (listener) => listen(IPC.exportProgress, listener),
    measureLoudness: (req) => ipcRenderer.invoke(IPC.exportLoudness, req),
  },

  shell: {
    showItemInFolder: (path) => ipcRenderer.send(IPC.shellShowItem, path),
  },

  app: {
    setTitle: (title) => ipcRenderer.send(IPC.appSetTitle, title),
    onCloseRequest: (listener) => listen(IPC.appCloseRequest, listener),
    confirmClose: () => ipcRenderer.send(IPC.appConfirmClose),
    onOpenFile: (listener) => listen(IPC.appOpenFile, listener),
    launchFile: () => ipcRenderer.invoke(IPC.appLaunchFile),
  },
};

contextBridge.exposeInMainWorld('scut', api);
