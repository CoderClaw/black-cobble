import { contextBridge, ipcRenderer } from 'electron';
import type { PrivateSessionStatus, VaultAPI } from '../shared/types';

// Native close can arrive before React mounts. Install this listener immediately
// and deliver a pending request to the currently subscribed callbacks.
const closeCallbacks = new Set<() => void>();
let closePending = false;
let closeQueued = false;

function deliverClose(): void {
  if (!closePending || closeQueued || closeCallbacks.size === 0) return;
  closeQueued = true;
  queueMicrotask(() => {
    closeQueued = false;
    if (!closePending || closeCallbacks.size === 0) return;
    closePending = false;
    for (const callback of [...closeCallbacks]) callback();
  });
}

ipcRenderer.on('vault:before-close', () => { closePending = true; deliverClose(); });

function subscribe(channel: string, callback: () => void): () => void {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: VaultAPI = {
  getVault: () => ipcRenderer.invoke('vault:get'),
  openVault: () => ipcRenderer.invoke('vault:open'),
  selectVaultMode: mode => ipcRenderer.invoke('vault:mode', mode),
  listEntries: () => ipcRenderer.invoke('vault:list'),
  readNote: path => ipcRenderer.invoke('vault:read', path),
  writeNote: (path, content, expectedVersion, sessionId) => ipcRenderer.invoke('vault:write', path, content, expectedVersion, sessionId),
  createNote: (parent, name, format) => ipcRenderer.invoke('vault:create-note', parent, name, format),
  createFolder: (parent, name) => ipcRenderer.invoke('vault:create-folder', parent, name),
  renameEntry: (path, name) => ipcRenderer.invoke('vault:rename', path, name),
  moveEntry: (path, destinationFolder) => ipcRenderer.invoke('vault:move', path, destinationFolder),
  trashEntry: path => ipcRenderer.invoke('vault:trash', path),
  openExternal: url => ipcRenderer.invoke('vault:external', url),
  searchNotes: (options, sessionId) => ipcRenderer.invoke('vault:search', options, sessionId),
  replaceInNotes: (options, replacement, targets, sessionId) => ipcRenderer.invoke('vault:replace', options, replacement, targets, sessionId),
  onVaultChanged: callback => subscribe('vault:changed', callback),
  onBeforeClose: callback => {
    closeCallbacks.add(callback);
    deliverClose();
    return () => { closeCallbacks.delete(callback); };
  },
  confirmClose: () => ipcRenderer.send('vault:confirm-close'),
  getPrivateSession: () => ipcRenderer.invoke('private:status'),
  setupPrivateSession: password => ipcRenderer.invoke('private:setup', password),
  unlockPrivateSession: password => ipcRenderer.invoke('private:unlock', password),
  lockPrivateSession: () => ipcRenderer.invoke('private:lock'),
  changePrivatePassword: (currentPassword, newPassword, sessionId) => ipcRenderer.invoke('private:password', currentPassword, newPassword, sessionId),
  setNotePrivate: (path, content, expectedVersion, encrypted, sessionId) => ipcRenderer.invoke('private:convert', path, content, expectedVersion, encrypted, sessionId),
  savePrivateDraft: (path, content, expectedVersion, revision, sessionId) => ipcRenderer.invoke('private:draft', path, content, expectedVersion, revision, sessionId),
  listPrivateDrafts: sessionId => ipcRenderer.invoke('private:drafts', sessionId),
  recoverPrivateDraft: (id, sessionId) => ipcRenderer.invoke('private:recover', id, sessionId),
  discardPrivateDraft: (id, sessionId) => ipcRenderer.invoke('private:discard', id, sessionId),
  createPrivateCopy: (parent, name, content, sessionId) => ipcRenderer.invoke('private:copy', parent, name, content, sessionId),
  acknowledgePrivateLock: () => ipcRenderer.send('private:lock-ack'),
  onPrivateSessionChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, status: PrivateSessionStatus) => callback(status);
    ipcRenderer.on('private:changed', listener);
    return () => ipcRenderer.removeListener('private:changed', listener);
  },
};

contextBridge.exposeInMainWorld('vault', api);

// Input listeners run in the isolated preload. Synthetic events cannot keep an
// unattended session open; background IPC and saves never call this channel.
let lastActivity = 0;
function reportActivity(event: Event): void {
  if (!event.isTrusted) return;
  const now = Date.now();
  if (now - lastActivity < 1_000) return;
  lastActivity = now;
  ipcRenderer.send('private:activity');
}
for (const event of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'input']) {
  globalThis.addEventListener(event, reportActivity, { capture: true, passive: true });
}
