import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type DiskLensApi } from '../shared/ipc'
import type { CleanupProgress, CleanupResult } from '../shared/cleanup'
import type { ScanProgress, ScanSummary } from '../shared/types'
import type { UninstallResult } from '../shared/uninstall'

// 허용된 채널만 노출하는 얇은 API. 검증 로직은 main에 있다. 이벤트 객체(ipcRenderer 이벤트)는 노출하지 않는다.
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: DiskLensApi = {
  ping: (req) => ipcRenderer.invoke(IPC_CHANNELS.ping, req),
  getSecurityInfo: () => ipcRenderer.invoke(IPC_CHANNELS.securityInfo),
  getDriveInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getDriveInfo),
  scan: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.scanStart),
    cancel: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanCancel, req),
    getChildren: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanGetChildren, req),
    getTop: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanGetTop, req),
    find: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanFind, req),
    getAncestors: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanGetAncestors, req),
    getTypeSummary: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanGetTypeSummary, req),
    getSkipped: (req) => ipcRenderer.invoke(IPC_CHANNELS.scanGetSkipped, req),
    loadCache: () => ipcRenderer.invoke(IPC_CHANNELS.scanLoadCache),
    onProgress: (cb) => subscribe<ScanProgress>(IPC_CHANNELS.scanProgress, cb),
    onDone: (cb) => subscribe<ScanSummary>(IPC_CHANNELS.scanDone, cb),
    onError: (cb) => subscribe<string>(IPC_CHANNELS.scanError, cb)
  },
  rules: {
    describe: (req) => ipcRenderer.invoke(IPC_CHANNELS.rulesDescribe, req)
  },
  programs: {
    list: (req) => ipcRenderer.invoke(IPC_CHANNELS.programsList, req),
    openFolder: (req) => ipcRenderer.invoke(IPC_CHANNELS.programsOpenFolder, req),
    uninstallPlan: (req) => ipcRenderer.invoke(IPC_CHANNELS.programsUninstallPlan, req),
    uninstall: (req) => ipcRenderer.invoke(IPC_CHANNELS.programsUninstall, req),
    onUninstallDone: (cb) => subscribe<UninstallResult>(IPC_CHANNELS.programsUninstallDone, cb)
  },
  cleanup: {
    items: () => ipcRenderer.invoke(IPC_CHANNELS.cleanupItems),
    analyze: (req) => ipcRenderer.invoke(IPC_CHANNELS.cleanupAnalyze, req),
    plan: (req) => ipcRenderer.invoke(IPC_CHANNELS.cleanupPlan, req),
    execute: (req) => ipcRenderer.invoke(IPC_CHANNELS.cleanupExecute, req),
    cancel: (req) => ipcRenderer.invoke(IPC_CHANNELS.cleanupCancel, req),
    history: () => ipcRenderer.invoke(IPC_CHANNELS.cleanupHistory),
    onProgress: (cb) => subscribe<CleanupProgress>(IPC_CHANNELS.cleanupProgress, cb),
    onDone: (cb) => subscribe<CleanupResult>(IPC_CHANNELS.cleanupDone, cb)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (req) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, req),
    pickFolder: (req) => ipcRenderer.invoke(IPC_CHANNELS.settingsPickFolder, req)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
    openFolder: (req) => ipcRenderer.invoke(IPC_CHANNELS.appOpenFolder, req),
    reloadRules: () => ipcRenderer.invoke(IPC_CHANNELS.appReloadRules)
  },
  shell: {
    showInExplorer: (req) => ipcRenderer.invoke(IPC_CHANNELS.showInExplorer, req),
    copyPath: (req) => ipcRenderer.invoke(IPC_CHANNELS.copyPath, req)
  }
}

contextBridge.exposeInMainWorld('api', api)
