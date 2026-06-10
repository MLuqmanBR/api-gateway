// Built to build/preload-popover.cjs. Exposes the minimal IPC surface the
// popover UI needs — no Node access in the renderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api-gateway', {
  snapshot: () => ipcRenderer.invoke('api-gateway:snapshot'),
  openDashboard: () => ipcRenderer.invoke('api-gateway:open-dashboard'),
  copyBaseUrl: () => ipcRenderer.invoke('api-gateway:copy-base-url'),
  copyApiKey: () => ipcRenderer.invoke('api-gateway:copy-api-key'),
  setLoginItem: (open: boolean) => ipcRenderer.invoke('api-gateway:set-login-item', open),
  serverState: () => ipcRenderer.invoke('api-gateway:server-state'),
  quit: () => ipcRenderer.invoke('api-gateway:quit'),
  onRefresh: (cb: () => void) => ipcRenderer.on('api-gateway:refresh', cb),
});
