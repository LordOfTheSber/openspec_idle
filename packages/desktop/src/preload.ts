import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * Мост окна к главному процессу. Интерфейс IDE по-прежнему ходит к своему
 * loopback-серверу; через мост идут только оконные действия: разделы из
 * меню и действия стартового экрана.
 */
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => callback(value);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('openspecDesktop', {
  platform: process.platform,
  onSection: (callback: (section: string) => void) => subscribe('desktop:section', callback),
  info: () => ipcRenderer.invoke('desktop:info'),
  recent: () => ipcRenderer.invoke('desktop:recent'),
  openDialog: () => ipcRenderer.invoke('desktop:open-dialog'),
  openPath: (path: string) => ipcRenderer.invoke('desktop:open-path', path),
  removeRecent: (path: string) => ipcRenderer.invoke('desktop:remove-recent', path),
  initFolder: (path: string) => ipcRenderer.invoke('desktop:init', path),
  onOfferInit: (callback: (path: string) => void) => subscribe('desktop:offer-init', callback),
  onRecentChanged: (callback: () => void) => subscribe('desktop:recent-changed', callback),
});
