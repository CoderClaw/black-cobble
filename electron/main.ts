import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VaultWorkspace } from './vault-workspace';
import { PrivateSessionTimer } from './session-timer';
import type { NoteDocument, PrivateSessionStatus, VaultInfo } from '../shared/types';
import { MAX_NOTE_BYTES, type NoteFormat } from '../shared/notes';

let window: BrowserWindow | null = null;
let vault: VaultWorkspace | null = null;
let confirmedClose = false;
let rendererURL = '';
let opening: Promise<VaultInfo | null> | undefined;
let privateEpoch = 0;
let changingVault = false;
let closing = false;
let recreating = false;
let lastSessionId: string | null = null;
let lockAckTimer: ReturnType<typeof setTimeout> | undefined;

const testTimeout = Number(process.env.BOVEDA_TEST_PRIVATE_TIMEOUT_MS);
const privateTimeout = !app.isPackaged && process.env.BOVEDA_TEST_VAULT && process.env.BOVEDA_USER_DATA
  && Number.isSafeInteger(testTimeout) && testTimeout >= 250 && testTimeout <= 600_000 ? testTimeout : 600_000;
const inactivity = new PrivateSessionTimer(privateTimeout, () => { void lockSession().catch(() => undefined); });

function status(): PrivateSessionStatus {
  return vault?.getPrivateSession() ?? { configured: false, unlocked: false, sessionId: null, vaultPath: '', recoveryCount: 0, memoryOnlyDrafts: false };
}

function clearLockAck(): void {
  if (lockAckTimer) clearTimeout(lockAckTimer);
  lockAckTimer = undefined;
}

function publishSession(source: VaultWorkspace, next: PrivateSessionStatus): void {
  if (vault !== source) return;
  const revoked = !!lastSessionId && !next.unlocked;
  lastSessionId = next.unlocked ? next.sessionId : null;
  inactivity.setSession(lastSessionId);
  if (revoked) privateEpoch++;
  if (!window || window.isDestroyed()) return;
  window.webContents.send('private:changed', next);
  if (revoked) {
    clearLockAck();
    const lockedWindow = window;
    lockAckTimer = setTimeout(() => {
      lockAckTimer = undefined;
      if (window !== lockedWindow || lockedWindow.isDestroyed()) return;
      // A hung renderer can retain its old editor. Destroy it without waiting
      // for renderer unload handlers, then reopen with the main session locked.
      void replaceRenderer(lockedWindow);
    }, 2_000);
    lockAckTimer.unref();
  }
}

async function lockSession(source = vault): Promise<PrivateSessionStatus> {
  privateEpoch++;
  inactivity.stop();
  if (!source) return status();
  return source.lockPrivateSession();
}

async function replaceRenderer(stale: BrowserWindow): Promise<void> {
  recreating = true;
  try {
    // Revocation is synchronous; stalled disk I/O must not keep the old
    // renderer's plaintext visible past the acknowledgement deadline.
    void lockSession().catch(() => undefined);
    if (window !== stale || stale.isDestroyed()) return;
    stale.destroy();
    await createWindow();
  } finally { recreating = false; }
}

async function preserveMemoryDrafts(source: VaultWorkspace): Promise<boolean> {
  while (source.getPrivateSession().memoryOnlyDrafts) {
    if (!window || window.isDestroyed()) return false;
    const choice = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Cambios sin guardar',
      message: 'Hay cambios privados que todavía no se han podido guardar.',
      detail: 'Reintenta guardarlos antes de salir, o descártalos de forma explícita.',
      buttons: ['Reintentar', 'Cancelar', 'Descartar cambios'], defaultId: 0, cancelId: 1,
      noLink: true,
    });
    if (choice.response === 1) return false;
    if (choice.response === 2) { source.discardMemoryPrivateDrafts(); return true; }
    try { await source.retryPersistPrivateDrafts(); } catch { /* Keep the encrypted drafts and offer another retry. */ }
  }
  return true;
}

if (process.env.BOVEDA_USER_DATA) {
  if (!path.isAbsolute(process.env.BOVEDA_USER_DATA)) throw new Error('BOVEDA_USER_DATA debe ser una ruta absoluta.');
  app.setPath('userData', process.env.BOVEDA_USER_DATA);
}
app.setName('Bóveda');
// Keep the alpha profile so the rename preserves the last vault and preferences.
if (!process.env.BOVEDA_USER_DATA) app.setPath('userData', app.getPath('userData'));
app.setName('Black Cobble');
app.enableSandbox();

function settingsPath(): string { return path.join(app.getPath('userData'), 'settings.json'); }

async function saveLastVault(root: string): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const file = settingsPath();
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ lastVault: root }), 'utf8');
  await fs.rename(temp, file);
}

async function selectVault(root: string, persist = true): Promise<VaultInfo> {
  if (changingVault || closing) throw new Error('Espera a que termine la operación actual.');
  changingVault = true;
  const previous = vault;
  let next: VaultWorkspace | undefined;
  try {
    await lockSession(previous);
    if (previous && !await preserveMemoryDrafts(previous)) return previous.info;
    next = new VaultWorkspace(root, {
      trash: absolute => shell.trashItem(absolute),
      onChange: () => { if (vault === next && window && !window.isDestroyed()) window.webContents.send('vault:changed'); },
      onPrivateSessionChanged: value => { if (next) publishSession(next, value); },
    });
    const info = await next.initialize();
    if (persist) await saveLastVault(info.path);
    vault = next;
    privateEpoch++;
    lastSessionId = null;
    await previous?.dispose();
    publishSession(next, next.getPrivateSession());
    if (window && !window.isDestroyed()) window.webContents.send('vault:changed');
    return info;
  } catch (error) { await next?.dispose(); throw error; }
  finally { changingVault = false; }
}

async function restoreVault(): Promise<void> {
  if (process.env.BOVEDA_TEST_VAULT) {
    if (!path.isAbsolute(process.env.BOVEDA_TEST_VAULT)) throw new Error('BOVEDA_TEST_VAULT debe ser una ruta absoluta.');
    await selectVault(process.env.BOVEDA_TEST_VAULT, false);
    return;
  }
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as { lastVault?: unknown };
    if (typeof settings.lastVault === 'string' && path.isAbsolute(settings.lastVault)) await selectVault(settings.lastVault, false);
  } catch { /* A removed vault or unreadable settings returns to the folder picker. */ }
}

function authorized(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Origen IPC no autorizado.');
  const actual = new URL(event.senderFrame.url);
  const expected = new URL(rendererURL);
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname) throw new Error('Origen IPC no autorizado.');
}

function requireVault(): VaultWorkspace {
  if (!vault) throw new Error('Abre una bóveda primero.');
  if (changingVault) throw new Error('Espera a que termine de abrirse la bóveda.');
  return vault;
}

function string(value: unknown, limit = 4096): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error('Argumento no válido.');
  return value;
}

function noteFormatArgument(value: unknown): NoteFormat {
  if (value === undefined) return 'md';
  if (value !== 'md' && value !== 'html') throw new Error('Formato de nota no válido.');
  return value;
}
function content(value: unknown): string {
  // Every UTF-16 unit takes at least one UTF-8 byte; storage checks the exact size before writing.
  if (typeof value !== 'string' || value.length > MAX_NOTE_BYTES) throw new Error('La nota es demasiado grande.');
  return value;
}

function version(value: unknown): string {
  const result = string(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Versión de nota no válida.');
  return result;
}

function session(value: unknown, source: VaultWorkspace): string {
  inactivity.check();
  if (source.info.kind !== 'private') throw new Error('Selecciona la bóveda privada.');
  const token = string(value, 128);
  const current = source.getPrivateSession();
  if (closing || !current.unlocked || !token || current.sessionId !== token) throw new Error('La sesión privada está bloqueada.');
  return token;
}

async function privateOperation<T>(token: unknown, action: (source: VaultWorkspace, id: string) => Promise<T>): Promise<T> {
  const source = requireVault();
  const id = session(token, source);
  const epoch = privateEpoch;
  const result = await action(source, id);
  inactivity.check();
  if (vault !== source || privateEpoch !== epoch || source.getPrivateSession().sessionId !== id) throw new Error('La sesión privada ha cambiado.');
  return result;
}

async function documentOperation(action: (source: VaultWorkspace) => Promise<NoteDocument>): Promise<NoteDocument> {
  inactivity.check();
  const source = requireVault();
  const activePath = source.info.path;
  const epoch = privateEpoch;
  const id = source.getPrivateSession().sessionId;
  const result = await action(source);
  inactivity.check();
  if (vault !== source || activePath !== source.info.path) throw new Error('La bóveda ha cambiado.');
  if (result.encrypted && !result.locked && (privateEpoch !== epoch || !id || source.getPrivateSession().sessionId !== id || result.sessionId !== id)) {
    throw new Error('La sesión privada ha cambiado.');
  }
  return result;
}

async function vaultOperation<T>(action: (source: VaultWorkspace) => Promise<T>): Promise<T> {
  const source = requireVault();
  const activePath = source.info.path;
  const epoch = privateEpoch;
  const result = await action(source);
  inactivity.check();
  if (vault !== source || source.info.path !== activePath || (source.info.kind === 'private' && epoch !== privateEpoch)) {
    throw new Error('La bóveda ha cambiado.');
  }
  return result;
}

async function openPrivateSession(password: unknown, setup: boolean): Promise<PrivateSessionStatus> {
  inactivity.check();
  const source = requireVault();
  if (source.info.kind !== 'private') throw new Error('Selecciona la bóveda privada.');
  if (closing) throw new Error('La aplicación se está cerrando.');
  const epoch = privateEpoch;
  const value = string(password, 1024);
  if (!value) throw new Error('Escribe una contraseña.');
  const result = await (setup ? source.setupPrivateSession(value) : source.unlockPrivateSession(value));
  if (vault !== source || epoch !== privateEpoch || closing || changingVault) {
    await source.lockPrivateSession();
    throw new Error('La sesión privada ha cambiado.');
  }
  if (!result.unlocked || !result.sessionId || source.getPrivateSession().sessionId !== result.sessionId) {
    throw new Error('La sesión privada ha cambiado.');
  }
  publishSession(source, result);
  return result;
}

async function finishClose(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    const source = vault;
    await lockSession(source);
    if (source && !await preserveMemoryDrafts(source)) return;
    confirmedClose = true;
    clearLockAck();
    window?.close();
  } finally { closing = false; }
}

function handlers(): void {
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => { authorized(event); inactivity.check(); return action(...args); });
  };
  handle('vault:get', () => vault?.info ?? null);
  handle('vault:open', () => {
    if (opening) return opening;
    opening = (async () => {
      if (process.env.BOVEDA_TEST_VAULT) return selectVault(process.env.BOVEDA_TEST_VAULT, false);
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        title: 'Abrir o crear una bóveda',
        buttonLabel: 'Abrir bóveda',
        defaultPath: vault?.info.path ?? app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled || !result.filePaths[0] ? null : selectVault(result.filePaths[0]);
    })().finally(() => { opening = undefined; });
    return opening;
  });
  handle('vault:mode', async mode => {
    if (mode !== 'normal' && mode !== 'private') throw new Error('Bóveda no válida.');
    const source = requireVault();
    if (closing) throw new Error('La aplicación se está cerrando.');
    changingVault = true;
    privateEpoch++;
    try {
      if (mode === 'normal') {
        await lockSession(source);
        if (!await preserveMemoryDrafts(source)) return source.info;
      }
      const info = await source.selectMode(mode);
      publishSession(source, source.getPrivateSession());
      window?.webContents.send('vault:changed');
      return info;
    } finally { changingVault = false; }
  });
  handle('vault:list', () => vaultOperation(source => source.listEntries()));
  handle('vault:read', input => documentOperation(source => source.readNote(string(input))));
  handle('vault:write', (input, draft, expected, token) => {
    if (token !== undefined) return privateOperation(token, (source, id) => source.writeNote(string(input), content(draft), version(expected), id));
    return documentOperation(source => source.writeNote(string(input), content(draft), version(expected)));
  });
  handle('vault:create-note', (parent, name, format) => documentOperation(source => source.createNote(string(parent), string(name), noteFormatArgument(format))));
  handle('vault:create-folder', (parent, name) => vaultOperation(source => source.createFolder(string(parent), string(name))));
  handle('vault:rename', (input, name) => vaultOperation(source => source.renameEntry(string(input), string(name))));
  handle('vault:move', (input, destination) => vaultOperation(source => source.moveEntry(string(input), string(destination))));
  handle('vault:trash', input => vaultOperation(source => source.trashEntry(string(input))));
  handle('vault:external', async input => {
    const url = new URL(string(input));
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('Este tipo de enlace no está permitido.');
    await shell.openExternal(url.href);
  });
  handle('private:status', () => status());
  handle('private:setup', password => openPrivateSession(password, true));
  handle('private:unlock', password => openPrivateSession(password, false));
  handle('private:lock', () => lockSession());
  handle('private:password', (current, next, token) => privateOperation(token,
    (source, id) => source.changePrivatePassword(string(current, 1024), string(next, 1024), id)));
  handle('private:convert', (input, draft, expected, encrypted, token) => {
    if (typeof encrypted !== 'boolean') throw new Error('Argumento no válido.');
    return privateOperation(token, (source, id) => source.setNotePrivate(string(input), content(draft), version(expected), encrypted, id));
  });
  handle('private:draft', (input, draft, expected, revision, token) => {
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Revisión no válida.');
    return privateOperation(token, (source, id) => source.savePrivateDraft(string(input), content(draft), version(expected), revision, id));
  });
  handle('private:drafts', token => privateOperation(token, (source, id) => source.listPrivateDrafts(id)));
  handle('private:recover', (draft, token) => privateOperation(token, (source, id) => source.recoverPrivateDraft(string(draft, 128), id)));
  handle('private:discard', (draft, token) => privateOperation(token, (source, id) => source.discardPrivateDraft(string(draft, 128), id)));
  handle('private:copy', (parent, name, draft, token) => privateOperation(token, (source, id) => source.createPrivateCopy(string(parent), string(name), content(draft), id)));
  ipcMain.on('private:activity', event => {
    try { authorized(event); } catch { return; }
    if (window?.isFocused() && !window.isMinimized()) inactivity.activity();
    else inactivity.check();
  });
  ipcMain.on('private:lock-ack', event => {
    try { authorized(event); } catch { return; }
    clearLockAck();
  });
  ipcMain.on('vault:confirm-close', event => {
    try { authorized(event); } catch { return; }
    void finishClose().catch(error => {
      if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', message: 'No se pudo cerrar la bóveda.', detail: error instanceof Error ? error.message : 'Inténtalo de nuevo.' });
    });
  });
}

async function createWindow(): Promise<void> {
  confirmedClose = false;
  let rendererReady = false;
  let rendererGone = false;
  let closeRequested = false;
  window = new BrowserWindow({
    width: 1280, height: 850, minWidth: 760, minHeight: 520,
    title: 'Black Cobble', backgroundColor: '#17191d', show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      rendererReady = false;
      void lockSession().catch(() => undefined);
    }
  });
  window.webContents.on('dom-ready', () => {
    rendererReady = true;
    rendererGone = false;
    if (closeRequested && window && !window.isDestroyed()) window.webContents.send('vault:before-close');
  });
  window.webContents.on('render-process-gone', () => {
    rendererGone = true;
    void lockSession().catch(() => undefined);
    // A crashed renderer cannot acknowledge the request or save its lost state.
    if (closeRequested) void finishClose();
  });
  window.on('close', event => {
    if (confirmedClose || !window || window.webContents.isDestroyed()) return;
    event.preventDefault();
    closeRequested = true;
    void lockSession().catch(() => undefined);
    if (rendererGone) { void finishClose(); return; }
    // Emit on every attempt, so a failed save can be resolved and closing retried.
    // Before dom-ready the preload may not exist yet. It buffers later requests.
    if (rendererReady) window.webContents.send('vault:before-close');
  });
  window.on('focus', () => inactivity.check());
  window.on('closed', () => { clearLockAck(); window = null; });
  window.once('ready-to-show', () => window?.show());
  const developmentURL = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  if (developmentURL) {
    const url = new URL(developmentURL);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('El servidor de desarrollo debe ser local.');
    rendererURL = url.href;
    await window.loadURL(rendererURL);
  } else {
    const index = path.join(__dirname, '../dist/index.html');
    rendererURL = pathToFileURL(index).href;
    await window.loadFile(index);
  }
}

app.whenReady().then(async () => {
  handlers();
  await restoreVault();
  await createWindow();
  powerMonitor.on('resume', () => inactivity.check());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch(error => {
  dialog.showErrorBox('No se pudo abrir Black Cobble', error instanceof Error ? error.message : String(error));
  app.exit(1);
});

app.on('window-all-closed', () => { if (!recreating && process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { inactivity.stop(); clearLockAck(); void lockSession(); void vault?.dispose(); });
