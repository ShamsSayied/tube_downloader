/**
 * preload.js — Electron Preload Script
 * Exposes safe IPC bridge between Main Process and Renderer (frontend).
 * Uses contextBridge so the renderer never has direct access to Node.js APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Analyze ────────────────────────────────────────────────
  analyze: (url) => ipcRenderer.invoke('analyze', url),

  // ─── Download ───────────────────────────────────────────────
  startDownload: (opts) => ipcRenderer.invoke('start-download', opts),
  downloadAction: (id, action) => ipcRenderer.invoke('download-action', { id, action }),

  // ─── File Operations ────────────────────────────────────────
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // ─── Settings ───────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ─── System Info ────────────────────────────────────────────
  getSysInfo: () => ipcRenderer.invoke('get-sysinfo'),

  // ─── History ────────────────────────────────────────────────
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // ─── Updates ────────────────────────────────────────────────
  updateYtdlp: () => ipcRenderer.invoke('update-ytdlp'),
  updateFfmpeg: () => ipcRenderer.invoke('update-ffmpeg'),

  // ─── Clipboard ──────────────────────────────────────────────
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),

  // ─── Window Controls ────────────────────────────────────────
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  // ─── Event Listeners (Main → Renderer) ──────────────────────
  onDownloadUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-update', handler);
    return () => ipcRenderer.removeListener('download-update', handler);
  },
  onDownloadAdded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-added', handler);
    return () => ipcRenderer.removeListener('download-added', handler);
  },
  onDownloadCompleted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-completed', handler);
    return () => ipcRenderer.removeListener('download-completed', handler);
  },
  onDownloadFailed: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-failed', handler);
    return () => ipcRenderer.removeListener('download-failed', handler);
  },
  onDownloadRemoved: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-removed', handler);
    return () => ipcRenderer.removeListener('download-removed', handler);
  },
  onCompletedRemoved: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('completed-removed', handler);
    return () => ipcRenderer.removeListener('completed-removed', handler);
  },
  onSettingsChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('settings-changed', handler);
    return () => ipcRenderer.removeListener('settings-changed', handler);
  },
  onInitData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('init-data', handler);
    return () => ipcRenderer.removeListener('init-data', handler);
  },
  onUpdateLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-log', handler);
    return () => ipcRenderer.removeListener('update-log', handler);
  },
  onWindowMaximized: (callback) => {
    const handler = (_event, maximized) => callback(maximized);
    ipcRenderer.on('window-maximized', handler);
    return () => ipcRenderer.removeListener('window-maximized', handler);
  },

  // ─── Request Init Data ──────────────────────────────────────
  requestInitData: () => ipcRenderer.invoke('request-init-data'),

  // ─── External Links ─────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
