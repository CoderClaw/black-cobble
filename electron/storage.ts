import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import type { NoteDocument, PrivateSessionStatus, PrivateDraftInfo, VaultEntry, VaultInfo } from '../shared/types';
import { isPrivateBytes, parseEnvelope, encryptEnvelope, decryptEnvelope, parseMetadata, wrapKey, unwrapKey, type PrivateMetadata } from './crypto';
import { rewriteWikiLinks } from '../shared/linkUpdates';
import { MAX_NOTE_BYTES, counterpartPaths, initialNoteContent, isNotePath, noteFormat, stripNoteExtension, withNoteExtension, type NoteFormat } from '../shared/notes';

type StorageOptions = {
  trash?: (absolutePath: string) => Promise<void>;
  onChange?: () => void;
  watch?: boolean;
  onPrivateSessionChanged?: (status: PrivateSessionStatus) => void;
};
type Draft = { id: string; path: string; noteId: string; expectedVersion: string; revision: number; updatedAt: number; bytes: Buffer; persisted: boolean; contentHash?: string; sessionId?: string; fallback?: Draft };

function fail(message: string): never { throw new Error(message); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
/** A directory entry the app can address: Linux allows names that relative() rejects, which must stay invisible instead of breaking traversals. */
function validName(name: string): boolean { return !!name && name !== '.' && name !== '..' && !/[<>:"|?*\\\x00-\x1f]/.test(name); }
function versionOf(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A saved note must open again: reject text that would exceed the read limit or change during UTF-8 encoding. */
function plainBytes(content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  // Unpaired UTF-16 surrogates would be silently replaced.
  if (bytes.toString('utf8') !== content) fail('El texto contiene caracteres no válidos.');
  if (bytes.length > MAX_NOTE_BYTES) fail(`La nota supera el tamaño máximo de ${MAX_NOTE_BYTES / 1024 / 1024} MiB.`);
  return bytes;
}

export class VaultService {
  private root: string;
  private tail: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private disposing = false;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private readonly options: StorageOptions;
  private metadata?: PrivateMetadata;
  private metadataVersion?: string;
  private pendingMetadataVersion?: string;
  private metadataError?: string;
  private recoveryError?: string;
  private privateKey?: Buffer;
  private sessionId: string | null = null;
  private generation = 0;
  private pendingLock?: Promise<PrivateSessionStatus>;
  private metadataWatcher?: FSWatcher;
  private knownPrivate = new Map<string, string>();
  private drafts = new Map<string, Draft>();

  constructor(root: string, options: StorageOptions = {}) {
    if (!path.isAbsolute(root)) fail('La ruta de la bóveda debe ser absoluta.');
    this.root = path.resolve(root);
    this.options = options;
  }

  async initialize(): Promise<VaultInfo> {
    this.root = await fs.realpath(this.root);
    if (!(await fs.stat(this.root)).isDirectory()) fail('La bóveda debe ser una carpeta.');
    await this.loadMetadata();
    await this.startWatcher();
    if (this.options.watch !== false) {
      this.metadataWatcher = chokidar.watch(path.join(this.root, '.black-cobble'), { ignoreInitial: true, followSymlinks: false });
      this.metadataWatcher.on('all', (_event, candidate) => {
        if (!this.metadataVersion) return;
        if (path.basename(candidate) === 'private.json' || path.resolve(candidate) === path.join(this.root, '.black-cobble')) {
          void this.checkMetadata().catch(() => undefined);
        }
      });
      this.metadataWatcher.on('error', () => { this.metadataError = 'No se puede vigilar el archivo de cifrado.'; void this.lockPrivateSession(); });
    }
    return this.info;
  }

  private async startWatcher(): Promise<void> {
    if (this.options.watch !== false && !this.disposing) {
      const watcher = chokidar.watch(this.root, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: (candidate: string) => path.relative(this.root, candidate).split(path.sep).some(part => part.startsWith('.')),
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      this.watcher = watcher;
      watcher.on('all', () => this.notify());
      watcher.on('error', () => this.notify());
      await new Promise<void>(resolve => {
        const ready = () => {
          watcher.removeListener('ready', ready);
          watcher.removeListener('error', ready);
          resolve();
        };
        watcher.once('ready', ready);
        watcher.once('error', ready);
      });
    }
  }

  private async relocateDirectory(operation: () => Promise<void>): Promise<void> {
    const watcher = this.watcher;
    if (!watcher) return operation();
    this.watcher = undefined;
    try {
      // Windows directory watchers can prevent rename and OS trash. Release all
      // handles, including nested directories, before the atomic filesystem move.
      await watcher.close();
      await new Promise<void>(resolve => setImmediate(resolve));
      await operation();
    } finally {
      // Rescan even on failure. Notify once so changes during the pause are read.
      await this.startWatcher();
      this.notify();
    }
  }

  get info(): VaultInfo { return { name: path.basename(this.root), path: this.root }; }

  async dispose(): Promise<void> {
    this.disposing = true;
    void this.lockPrivateSession();
    await this.tail.catch(() => undefined);
    await this.watcher?.close();
    await this.metadataWatcher?.close();
    if (this.changeTimer) clearTimeout(this.changeTimer);
  }

  private notify(): void {
    if (this.disposing) return;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.options.onChange?.(), 80);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private relative(input: string, allowRoot = false): string {
    if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) fail('Ruta no válida.');
    if (input === '' && allowRoot) return '';
    const parts = input.split('/');
    if (!parts.length || parts.some(part => !validName(part))) fail('Ruta no válida.');
    return parts.join('/');
  }

  private inside(absolute: string): boolean {
    const relative = path.relative(this.root, absolute);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }

  /** Check every component: realpath alone would allow a symlink back into the vault. */
  private async resolve(input: string, allowRoot = false): Promise<string> {
    const relative = this.relative(input, allowRoot);
    let current = this.root;
    if (!(await fs.lstat(current)).isDirectory()) fail('La carpeta de la bóveda ya no está disponible.');
    if ((await fs.realpath(current)) !== this.root) fail('La carpeta de la bóveda ha cambiado.');
    for (const part of relative ? relative.split('/') : []) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail('No se permiten enlaces simbólicos en la bóveda.');
    }
    const real = await fs.realpath(current);
    if (!this.inside(real)) fail('La ruta está fuera de la bóveda.');
    return current;
  }

  private async folder(input: string): Promise<string> {
    const absolute = await this.resolve(input, true);
    if (!(await fs.stat(absolute)).isDirectory()) fail('El destino debe ser una carpeta.');
    return absolute;
  }

  private name(input: string, note = false, format: NoteFormat = 'md'): string {
    if (typeof input !== 'string') fail('Nombre no válido.');
    const name = input.trim();
    if (!name || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('Nombre no válido.');
    const result = note ? withNoteExtension(name, format) : name;
    if (Buffer.byteLength(result, 'utf8') > 240) fail('El nombre es demasiado largo.');
    return result;
  }

  private notePath(input: string): string {
    const relative = this.relative(input);
    if (!isNotePath(relative)) fail('Solo se pueden editar notas Markdown (.md) o HTML (.html).');
    return relative;
  }

  /** Names collide case-insensitively (Windows, macOS, and wikilinks on any OS); `except` is the entry being renamed. */
  private async unused(absolute: string, note = false, except?: string): Promise<void> {
    const folder = path.dirname(absolute);
    const taken = new Set((await fs.readdir(folder)).filter(entry => !except || path.join(folder, entry) !== except).map(entry => entry.toLowerCase()));
    if (taken.has(path.basename(absolute).toLowerCase())) fail('Ya existe una nota o carpeta con ese nombre.');
    // Nota.md and Nota.html side by side would make [[Nota]] ambiguous.
    if (note) for (const other of counterpartPaths(absolute)) if (taken.has(path.basename(other).toLowerCase())) fail('Ya existe una nota con ese nombre en otro formato.');
  }

  private async raw(input: string): Promise<{ path: string; bytes: Buffer; version: string }> {
    const relative = this.notePath(input);
    const absolute = await this.resolve(relative);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) fail('La nota debe ser un archivo.');
      if (stat.size > MAX_NOTE_BYTES) fail('La nota es demasiado grande para abrirse.');
      const bytes = await handle.readFile();
      return { path: relative, bytes, version: versionOf(bytes) };
    } finally { await handle.close(); }
  }

  private async read(input: string): Promise<NoteDocument> {
      const { path: relative, bytes, version } = await this.raw(input);
      if (isPrivateBytes(bytes)) {
        const envelope = parseEnvelope(bytes);
        if (envelope.purpose !== 'note') fail('El archivo no es una nota cifrada.');
        this.knownPrivate.set(relative, envelope.noteId);
        if (!this.privateKey || !this.sessionId) return { path: relative, content: '', version, encrypted: true, locked: true };
        const sid = this.sessionId;
        await this.checkMetadata();
        const key = this.requireSession(sid);
        const content = decryptEnvelope(key, envelope, this.metadata!.vaultId);
        this.requireSession(sid);
        return { path: relative, content, version, encrypted: true, locked: false, sessionId: sid };
      }
      if (this.knownPrivate.has(relative)) fail('CONFLICT: Una nota privada se ha sustituido por texto público.');
      let content: string;
      try { content = decoder.decode(bytes); }
      catch { fail('La nota no contiene texto UTF-8 válido.'); }
      return { path: relative, content, version };
  }
  private async encryptedMarker(relative: string): Promise<boolean> {
    const handle = await fs.open(await this.resolve(relative), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!(await handle.stat()).isFile()) return false;
      const prefix = Buffer.alloc(48); const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      return isPrivateBytes(prefix.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }

  getPrivateSession(): PrivateSessionStatus {
    const error = this.metadataError ?? this.recoveryError;
    return { configured: !!this.metadata, unlocked: !!this.privateKey && !!this.sessionId, sessionId: this.sessionId, vaultPath: this.root, recoveryCount: this.drafts.size, memoryOnlyDrafts: [...this.drafts.values()].some(draft => !draft.persisted), ...(error ? { error } : {}) };
  }
  private privateChanged(): void { if (!this.disposing) this.options.onPrivateSessionChanged?.(this.getPrivateSession()); }
  private requireSession(sid: string | undefined): Buffer {
    if (!sid || sid !== this.sessionId || !this.privateKey || !this.metadata || this.metadataError || this.disposing) fail('La sesión privada está bloqueada o ha caducado.');
    return this.privateKey;
  }
  lockPrivateSession(): Promise<PrivateSessionStatus> {
    if (this.pendingLock && !this.privateKey) return this.pendingLock;
    const commits: { draft: Draft; bytes: Buffer }[] = [];
    if (this.privateKey && this.metadata && !this.metadataError) {
      for (const draft of this.drafts.values()) {
        if (draft.sessionId !== this.sessionId) continue;
        try {
          const content = decryptEnvelope(this.privateKey, parseEnvelope(draft.bytes), this.metadata.vaultId, 'draft');
          commits.push({ draft, bytes: encryptEnvelope(this.privateKey, this.metadata.vaultId, draft.noteId, content) });
        } catch { /* Keep damaged recovery bytes for explicit handling. */ }
      }
    }
    this.generation++;
    this.sessionId = null;
    this.privateKey?.fill(0);
    this.privateKey = undefined;
    this.privateChanged();
    if (!commits.length) return Promise.resolve(this.getPrivateSession());
    const pending = this.serialized(async () => {
      for (const { draft, bytes } of commits) {
        if (this.drafts.get(draft.id) !== draft) continue;
        try {
          if (this.metadataError) fail(this.metadataError);
          await this.checkMetadata();
          await this.replaceNote(draft.path, bytes, draft.expectedVersion, undefined, async () => { if (this.metadataError) fail(this.metadataError); await this.checkMetadata(); });
          await this.removeDraft(draft);
          this.notify();
        } catch {
          // A conflict or unavailable disk leaves its encrypted journal available.
          if (!draft.persisted) await this.persistDraft(draft).catch(() => undefined);
          this.privateChanged();
        }
      }
      return this.getPrivateSession();
    });
    this.pendingLock = pending;
    void pending.finally(() => { if (this.pendingLock === pending) this.pendingLock = undefined; });
    return pending;
  }
  private async loadMetadata(): Promise<void> {
    try {
      const absolute = await this.resolve('.black-cobble/private.json');
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 4096) fail('El archivo de cifrado no es válido.');
      const bytes = await fs.readFile(absolute);
      this.metadata = parseMetadata(bytes); this.metadataVersion = versionOf(bytes); this.metadataError = undefined;
      await this.loadDrafts();
    } catch (error) {
      this.metadata = undefined; this.metadataVersion = undefined;
      if (!isMissing(error)) this.metadataError = 'El archivo de cifrado está dañado. Restaura .black-cobble/private.json desde una copia de seguridad.';
    }
  }
  private async checkMetadata(): Promise<void> {
    try {
      const absolute = await this.resolve('.black-cobble/private.json');
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 4096) fail('El archivo de cifrado no es válido.');
      const version = versionOf(await fs.readFile(absolute));
      if (version !== this.metadataVersion && version !== this.pendingMetadataVersion) fail('El archivo de cifrado ha cambiado.');
    } catch {
      this.metadataError = 'El archivo de cifrado ha cambiado o no está disponible. Cierra y abre la bóveda para comprobarlo.';
      void this.lockPrivateSession();
      fail(this.metadataError);
    }
  }
  private async hiddenFolder(child = ''): Promise<string> {
    await this.folder('');
    for (const relative of ['.black-cobble', ...(child ? [`.black-cobble/${child}`] : [])]) {
      try { await this.folder(relative); }
      catch (error) {
        if (!isMissing(error)) throw error;
        await fs.mkdir(path.join(this.root, relative));
        await this.folder(relative);
      }
    }
    return this.folder(child ? `.black-cobble/${child}` : '.black-cobble');
  }
  private async atomicHidden(relative: string, bytes: Buffer, verify?: () => Promise<void>, exclusive = false): Promise<void> {
    const folder = await this.folder(path.posix.dirname(relative));
    const absolute = path.join(this.root, relative);
    const temp = path.join(folder, `.private-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.folder(path.posix.dirname(relative));
      try { await this.resolve(relative); } catch (error) { if (!isMissing(error)) throw error; }
      await verify?.();
      if (exclusive) { await fs.link(temp, absolute); await fs.unlink(temp); }
      else await fs.rename(temp, absolute);
    } finally { await fs.unlink(temp).catch(error => { if (!isMissing(error)) throw error; }); }
  }
  setupPrivateSession(password: string): Promise<PrivateSessionStatus> {
    const generation = this.generation;
    return this.serialized(async () => {
      if (this.metadata || this.metadataError) fail('El cifrado ya está configurado o necesita restaurar sus metadatos.');
      // Avoid nesting a serialized list operation inside the queue.
      const scan = async (relative = ''): Promise<boolean> => {
        for (const item of await fs.readdir(await this.folder(relative), { withFileTypes: true })) {
          if (item.isSymbolicLink() || !validName(item.name)) continue;
          const file = relative ? `${relative}/${item.name}` : item.name;
          if (item.isDirectory() && !item.name.startsWith('.') && await scan(file)) return true;
          if (item.isFile() && isNotePath(file) && await this.encryptedMarker(file)) return true;
        }
        return false;
      };
      if (await scan()) fail('Falta .black-cobble/private.json. Restaura los metadatos desde una copia de seguridad.');
      try { if ((await fs.readdir(await this.folder('.black-cobble/drafts'))).length) fail('Existen borradores cifrados sin metadatos. Restaura private.json.'); } catch (error) { if (!isMissing(error)) throw error; }
      const key = randomBytes(32);
      try {
        const metadata = await wrapKey(password, key);
        if (generation !== this.generation || this.disposing) fail('La sesión privada ha caducado.');
        await this.hiddenFolder();
        const bytes = Buffer.from(JSON.stringify(metadata));
        await this.atomicHidden('.black-cobble/private.json', bytes, async () => { if (generation !== this.generation || this.disposing) fail('La sesión privada ha caducado.'); }, true);
        this.metadata = metadata; this.metadataVersion = versionOf(bytes);
        if (generation !== this.generation || this.disposing) fail('La sesión privada ha caducado.');
        this.privateKey = Buffer.from(key); this.sessionId = randomUUID(); this.privateChanged();
        return this.getPrivateSession();
      } finally { key.fill(0); }
    });
  }
  unlockPrivateSession(password: string): Promise<PrivateSessionStatus> {
    const generation = this.generation;
    return this.serialized(async () => {
      if (!this.metadata || this.metadataError) fail(this.metadataError ?? 'La bóveda no tiene cifrado configurado.');
      await this.checkMetadata();
      const key = await unwrapKey(password, this.metadata);
      try {
        await this.checkMetadata();
        if (generation !== this.generation || this.disposing) fail('La sesión privada ha caducado.');
        this.privateKey?.fill(0); this.privateKey = Buffer.from(key); this.sessionId = randomUUID(); this.privateChanged();
        return this.getPrivateSession();
      } finally { key.fill(0); }
    });
  }
  changePrivatePassword(currentPassword: string, newPassword: string, sid: string): Promise<void> {
    this.requireSession(sid);
    return this.serialized(async () => {
      await this.checkMetadata(); const key = this.requireSession(sid);
      const verified = await unwrapKey(currentPassword, this.metadata!);
      try {
        this.requireSession(sid);
        if (!verified.equals(key)) fail('Contraseña incorrecta.');
        const metadata = await wrapKey(newPassword, verified, this.metadata!.vaultId);
        const bytes = Buffer.from(JSON.stringify(metadata));
        await this.checkMetadata(); this.requireSession(sid);
        this.pendingMetadataVersion = versionOf(bytes);
        try {
          await this.atomicHidden('.black-cobble/private.json', bytes, async () => { await this.checkMetadata(); this.requireSession(sid); });
          this.metadata = metadata; this.metadataVersion = versionOf(bytes);
        } finally { this.pendingMetadataVersion = undefined; }
        await this.checkMetadata(); this.requireSession(sid);
      } finally { verified.fill(0); }
    });
  }
  private async replaceNote(relative: string, bytes: Buffer, expectedVersion: string, sid?: string, verify?: () => Promise<void>): Promise<void> {
    const absolute = await this.resolve(relative);
    const temp = path.join(path.dirname(absolute), `.boveda-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', (await fs.stat(absolute)).mode);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.resolve(relative);
      if ((await this.raw(relative)).version !== expectedVersion) fail('CONFLICT: La nota ha cambiado fuera de la aplicación.');
      if (sid) { await this.checkMetadata(); this.requireSession(sid); }
      await verify?.();
      await fs.rename(temp, absolute);
    } finally { await fs.unlink(temp).catch(error => { if (!isMissing(error)) throw error; }); }
  }
  setNotePrivate(input: string, content: string, expectedVersion: string, encrypted: boolean, sid: string): Promise<NoteDocument> {
    this.requireSession(sid);
    return this.serialized(async () => {
      if (typeof content !== 'string' || typeof expectedVersion !== 'string' || typeof encrypted !== 'boolean') fail('Contenido no válido.');
      await this.checkMetadata(); const key = this.requireSession(sid);
      const current = await this.read(input); this.requireSession(sid);
      if (current.version !== expectedVersion) fail('CONFLICT: La nota ha cambiado fuera de la aplicación.');
      if (!encrypted && !current.encrypted) fail('La nota ya es pública.');
      const noteId = this.knownPrivate.get(current.path) ?? randomUUID();
      const bytes = encrypted ? encryptEnvelope(key, this.metadata!.vaultId, noteId, content) : plainBytes(content);
      await this.replaceNote(current.path, bytes, expectedVersion, sid); this.requireSession(sid);
      if (encrypted) this.knownPrivate.set(current.path, noteId); else this.knownPrivate.delete(current.path);
      const draft = this.drafts.get(noteId); if (draft?.contentHash === versionOf(Buffer.from(content))) await this.removeDraft(draft);
      this.requireSession(sid); this.notify();
      return { path: current.path, content, version: versionOf(bytes), ...(encrypted ? { encrypted: true, locked: false, sessionId: sid } : {}) };
    });
  }
  createPrivateCopy(parent: string, name: string, content: string, sid: string): Promise<NoteDocument> {
    this.requireSession(sid);
    return this.serialized(() => this.privateCopy(parent, name, content, sid));
  }
  private async privateCopy(parent: string, name: string, content: string, sid: string): Promise<NoteDocument> {
    await this.checkMetadata(); const key = this.requireSession(sid);
    const folder = await this.folder(parent); const filename = this.name(name, true);
    const relative = parent ? `${parent}/${filename}` : filename;
    const noteId = randomUUID(); const bytes = encryptEnvelope(key, this.metadata!.vaultId, noteId, content);
    await this.unused(path.join(folder, filename), true); this.requireSession(sid);
    const temp = path.join(folder, `.boveda-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.folder(parent); await this.checkMetadata(); this.requireSession(sid);
      await fs.link(temp, path.join(folder, filename));
    } finally { await fs.unlink(temp).catch(error => { if (!isMissing(error)) throw error; }); }
    this.requireSession(sid); this.knownPrivate.set(relative, noteId); this.notify();
    return { path: relative, content, version: versionOf(bytes), encrypted: true, locked: false, sessionId: sid };
  }
  savePrivateDraft(input: string, content: string, expectedVersion: string, revision: number, sid: string): Promise<void> {
    // This deliberately happens before any awaited work: lock can zero the key immediately.
    const key = this.requireSession(sid); const relative = this.notePath(input);
    if (typeof content !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion) || !Number.isSafeInteger(revision) || revision < 0) fail('Borrador no válido.');
    const noteId = this.knownPrivate.get(relative); if (!noteId) fail('La nota privada debe abrirse antes de guardar un borrador.');
    const previous = this.drafts.get(noteId);
    if (previous?.sessionId === sid && revision <= previous.revision) return Promise.resolve();
    if (!previous && this.drafts.size >= 32) fail('Hay demasiados borradores pendientes. Recupera o descarta alguno.');
    const draft: Draft = { id: noteId, noteId, path: relative, expectedVersion, revision, updatedAt: Date.now(), bytes: encryptEnvelope(key, this.metadata!.vaultId, noteId, content, 'draft'), persisted: false, contentHash: versionOf(Buffer.from(content)), sessionId: sid, fallback: previous?.persisted ? previous : previous?.fallback };
    this.drafts.set(noteId, draft); this.privateChanged();
    return this.serialized(async () => { if (this.drafts.get(noteId) === draft) await this.persistDraft(draft); });
  }
  private async persistDraft(draft: Draft): Promise<void> {
    await this.checkMetadata(); await this.hiddenFolder('drafts');
    const bytes = Buffer.from(JSON.stringify({ id: draft.id, path: draft.path, noteId: draft.noteId, expectedVersion: draft.expectedVersion, revision: draft.revision, updatedAt: draft.updatedAt, envelope: draft.bytes.toString('base64') }));
    await this.atomicHidden(`.black-cobble/drafts/${draft.id}.json`, bytes, () => this.checkMetadata());
    draft.persisted = true; draft.fallback = undefined; this.privateChanged();
  }
  retryPersistPrivateDrafts(): Promise<boolean> { return this.serialized(async () => { for (const draft of this.drafts.values()) if (!draft.persisted) { try { await this.persistDraft(draft); } catch { /* retain encrypted memory */ } } return !this.getPrivateSession().memoryOnlyDrafts; }); }
  discardMemoryPrivateDrafts(): void { for (const [id, draft] of this.drafts) if (!draft.persisted) { if (draft.fallback) this.drafts.set(id, draft.fallback); else this.drafts.delete(id); } this.privateChanged(); }
  private async loadDrafts(): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(await this.folder('.black-cobble/drafts')); } catch (error) { if (isMissing(error)) return; throw error; }
    names = names.filter(name => !/^\.private-[a-f0-9-]{36}\.tmp$/.test(name));
    if (names.length > 32) this.recoveryError = 'Hay demasiados archivos de recuperación. Revisa .black-cobble/drafts.';
    for (const name of names.slice(0, 32)) {
      try {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) fail('Archivo de recuperación no válido.');
      const absolute = await this.resolve(`.black-cobble/drafts/${name}`);
      if ((await fs.stat(absolute)).size > 48 * 1024 * 1024) fail('Archivo de recuperación demasiado grande.');
      const record = JSON.parse(await fs.readFile(absolute, 'utf8'));
      if (!record || typeof record !== 'object' || record.id !== name.slice(0, -5) || record.noteId !== record.id || !/^[a-f0-9]{64}$/.test(record.expectedVersion) || !Number.isSafeInteger(record.revision) || record.revision < 0 || !Number.isSafeInteger(record.updatedAt) || typeof record.envelope !== 'string') fail('Archivo de recuperación no válido.');
      const relative = this.notePath(record.path); const bytes = Buffer.from(record.envelope, 'base64');
      if (bytes.toString('base64') !== record.envelope) fail('Archivo de recuperación no válido.');
      const envelope = parseEnvelope(bytes);
      if (envelope.purpose !== 'draft' || envelope.vaultId !== this.metadata!.vaultId || envelope.noteId !== record.id) fail('Archivo de recuperación no válido.');
      this.drafts.set(record.id, { id: record.id, noteId: record.noteId, expectedVersion: record.expectedVersion, revision: record.revision, updatedAt: record.updatedAt, path: relative, bytes, persisted: true });
      } catch { this.recoveryError = 'Hay un borrador de recuperación dañado. Se conserva en .black-cobble/drafts para revisarlo.'; }
    }
  }
  listPrivateDrafts(sid: string): Promise<PrivateDraftInfo[]> { this.requireSession(sid); return this.serialized(async () => { await this.checkMetadata(); this.requireSession(sid); return [...this.drafts.values()].map(({ id, path: draftPath, updatedAt }) => ({ id, path: draftPath, updatedAt })); }); }
  private async removeDraft(draft: Draft): Promise<void> {
    const relative = `.black-cobble/drafts/${draft.id}.json`;
    try { await fs.unlink(await this.resolve(relative)); } catch (error) { if (!isMissing(error)) throw error; }
    if (this.drafts.get(draft.id) === draft) this.drafts.delete(draft.id);
    this.privateChanged();
  }
  discardPrivateDraft(id: string, sid: string): Promise<void> { this.requireSession(sid); return this.serialized(async () => { await this.checkMetadata(); this.requireSession(sid); const draft = this.drafts.get(id); if (!draft) fail('El borrador no existe.'); await this.removeDraft(draft); this.requireSession(sid); }); }
  recoverPrivateDraft(id: string, sid: string): Promise<NoteDocument> {
    this.requireSession(sid);
    return this.serialized(async () => {
      await this.checkMetadata(); const key = this.requireSession(sid); const draft = this.drafts.get(id); if (!draft) fail('El borrador no existe.');
      const content = decryptEnvelope(key, parseEnvelope(draft.bytes), this.metadata!.vaultId, 'draft');
      const base = stripNoteExtension(path.posix.basename(draft.path));
      const result = await this.privateCopy('', withNoteExtension(`${base} recuperado ${randomUUID().slice(0, 8)}`, noteFormat(draft.path) ?? 'md'), content, sid);
      await this.removeDraft(draft); this.requireSession(sid); return result;
    });
  }

  listEntries(): Promise<VaultEntry[]> {
    return this.serialized(async () => {
      const visit = async (relative: string): Promise<VaultEntry[]> => {
        const absolute = await this.folder(relative);
        const entries: VaultEntry[] = [];
        for (const item of await fs.readdir(absolute, { withFileTypes: true })) {
          if (item.name.startsWith('.') || item.isSymbolicLink() || !validName(item.name)) continue;
          const itemPath = relative ? `${relative}/${item.name}` : item.name;
          try {
            const itemAbsolute = await this.resolve(itemPath);
            const stat = await fs.lstat(itemAbsolute);
            if (stat.isDirectory()) entries.push({ name: item.name, path: itemPath, type: 'folder', children: await visit(itemPath) });
            else if (stat.isFile() && isNotePath(item.name)) {
              entries.push({ name: item.name, path: itemPath, type: 'file', ...(await this.encryptedMarker(itemPath) ? { encrypted: true } : {}) });
            }
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        return entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
      };
      return visit('');
    });
  }

  readNote(input: string): Promise<NoteDocument> { return this.serialized(() => this.read(input)); }

  writeNote(input: string, content: string, expectedVersion: string, sessionId?: string): Promise<NoteDocument> {
    return this.serialized(async () => {
      if (typeof content !== 'string' || typeof expectedVersion !== 'string') fail('Contenido o versión no válidos.');
      let bytes: Buffer = plainBytes(content);
      let current: NoteDocument;
      try { current = await this.read(input); }
      catch (error) { if (isMissing(error)) fail('CONFLICT: La nota se ha eliminado o movido fuera de la aplicación.'); throw error; }
      if (current.version !== expectedVersion) fail('CONFLICT: La nota ha cambiado fuera de la aplicación.');
      if (current.encrypted) {
        await this.checkMetadata();
        const encryptedBytes = encryptEnvelope(this.requireSession(sessionId), this.metadata!.vaultId, this.knownPrivate.get(current.path)!, content);
        bytes.fill(0); bytes = encryptedBytes;
      }
      await this.replaceNote(current.path, bytes, expectedVersion, current.encrypted ? sessionId : undefined);
      if (current.encrypted) {
        this.requireSession(sessionId);
        const draft = this.drafts.get(this.knownPrivate.get(current.path)!);
        if (draft?.contentHash === versionOf(Buffer.from(content))) await this.removeDraft(draft);
        this.requireSession(sessionId);
      }
      this.notify();
      return { path: current.path, content, version: versionOf(bytes), ...(current.encrypted ? { encrypted: true, locked: false, sessionId } : {}) };
    });
  }

  createNote(parent: string, name: string, format: NoteFormat = 'md'): Promise<NoteDocument> {
    return this.serialized(async () => {
      if (format !== 'md' && format !== 'html') fail('Formato de nota no válido.');
      const folder = await this.folder(parent);
      const filename = this.name(name, true, format);
      const absolute = path.join(folder, filename);
      await this.unused(absolute, true);
      await fs.writeFile(absolute, initialNoteContent(filename), { flag: 'wx' });
      this.notify();
      return this.read(parent ? `${parent}/${filename}` : filename);
    });
  }

  createFolder(parent: string, name: string): Promise<string> {
    return this.serialized(async () => {
      const folder = await this.folder(parent);
      const filename = this.name(name);
      await this.unused(path.join(folder, filename));
      await fs.mkdir(path.join(folder, filename));
      this.notify();
      return parent ? `${parent}/${filename}` : filename;
    });
  }

  private async relocate(input: string, destination: string, name?: string): Promise<string> {
    const relative = this.relative(input);
    const source = await this.resolve(relative);
    const stat = await fs.stat(source);
    if (!stat.isDirectory() && (!stat.isFile() || !isNotePath(relative))) fail('Solo se pueden gestionar notas Markdown, HTML y carpetas.');
    const folder = await this.folder(destination);
    const format = noteFormat(relative) ?? 'md';
    const filename = name === undefined ? path.basename(source) : this.name(name, stat.isFile(), format);
    if (stat.isFile() && noteFormat(filename) !== format) fail('No se puede cambiar el formato de una nota al renombrarla.');
    const target = path.join(folder, filename);
    if (target === source) return relative;
    const withinSource = path.relative(source, target);
    if (stat.isDirectory() && (withinSource === '' || (!withinSource.startsWith(`..${path.sep}`) && withinSource !== '..' && !path.isAbsolute(withinSource)))) fail('No puedes mover una carpeta dentro de sí misma.');
    // Filesystem-agnostic: on case-insensitive volumes the source itself matches the target.
    const caseOnlyRename = path.dirname(source) === path.dirname(target) && path.basename(source).toLowerCase() === path.basename(target).toLowerCase();
    await this.unused(target, stat.isFile(), caseOnlyRename ? source : undefined);
    const result = destination ? `${destination}/${filename}` : filename;
    if (this.metadata && !this.privateKey) fail('Desbloquea las notas privadas antes de mover o renombrar para conservar sus enlaces.');
    const notePaths = async (): Promise<string[]> => {
      const notes: string[] = [];
      const visit = async (parent: string): Promise<void> => {
        for (const item of await fs.readdir(await this.folder(parent), { withFileTypes: true })) {
          if (item.name.startsWith('.') || item.isSymbolicLink() || !validName(item.name)) continue;
          const child = parent ? `${parent}/${item.name}` : item.name;
          const absolute = await this.resolve(child);
          const childStat = await fs.lstat(absolute);
          if (childStat.isDirectory()) await visit(child);
          else if (childStat.isFile() && isNotePath(item.name)) notes.push(child);
        }
      };
      await visit('');
      return notes.sort();
    };
    const pathsBefore = await notePaths();
    const pathMap = new Map(pathsBefore.filter(note => note === relative || note.startsWith(`${relative}/`)).map(note => [note, result + note.slice(relative.length)]));
    const snapshots: { path: string; bytes: Buffer; version: string; after: string; bytesAfter: Buffer; sid?: string }[] = [];
    for (const note of pathsBefore) {
      const original = await this.raw(note);
      let content: string;
      let sid: string | undefined;
      if (isPrivateBytes(original.bytes)) {
        await this.checkMetadata();
        sid = this.sessionId ?? undefined;
        content = decryptEnvelope(this.requireSession(sid), parseEnvelope(original.bytes), this.metadata!.vaultId);
      } else {
        try { content = decoder.decode(original.bytes); }
        catch { fail(`La nota ${note} no contiene texto UTF-8 válido.`); }
      }
      const after = pathMap.get(note) ?? note;
      const rewritten = rewriteWikiLinks(content, note, after, pathsBefore, pathMap);
      const bytes = rewritten === content ? original.bytes : sid
        ? encryptEnvelope(this.requireSession(sid), this.metadata!.vaultId, parseEnvelope(original.bytes).noteId, rewritten)
        : Buffer.from(rewritten, 'utf8');
      snapshots.push({ ...original, after, bytesAfter: bytes, sid });
    }
    const move = async () => {
      // Revalidate after watcher teardown, which yields to external processes.
      await this.resolve(relative);
      await this.folder(destination);
      await this.unused(target, stat.isFile(), caseOnlyRename ? source : undefined);
      if (JSON.stringify(await notePaths()) !== JSON.stringify(pathsBefore)) fail('CONFLICT: Las notas han cambiado fuera de la aplicación.');
      for (const note of snapshots) {
        if ((await this.raw(note.path)).version !== note.version) fail('CONFLICT: Una nota ha cambiado fuera de la aplicación.');
        if (note.sid) { await this.checkMetadata(); this.requireSession(note.sid); }
      }
      await fs.rename(source, target);
      const written: typeof snapshots = [];
      try {
        for (const note of snapshots) {
          if (note.bytesAfter === note.bytes) continue;
          await this.replaceNote(note.after, note.bytesAfter, note.version, note.sid);
          written.push(note);
        }
      } catch (error) {
        const recoveryFailures: string[] = [];
        for (const note of written.reverse()) {
          // Restore original bytes only if an external edit hasn't replaced our write.
          try { await this.replaceNote(note.after, note.bytes, versionOf(note.bytesAfter)); }
          catch { recoveryFailures.push(note.after); }
        }
        if (!recoveryFailures.length) {
          try {
            await this.resolve(result);
            await this.unused(source, false, caseOnlyRename ? target : undefined);
            await fs.rename(target, source);
          } catch { recoveryFailures.push(result); }
        }
        this.notify();
        if (recoveryFailures.length) fail(`El movimiento a ${result} quedó incompleto. Revisa estos archivos antes de continuar: ${recoveryFailures.join(', ')}. ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    };
    if (stat.isDirectory()) await this.relocateDirectory(move);
    else await move();
    for (const [oldPath, id] of [...this.knownPrivate]) {
      if (oldPath === relative || oldPath.startsWith(`${relative}/`)) {
        this.knownPrivate.delete(oldPath); this.knownPrivate.set(result + oldPath.slice(relative.length), id);
      }
    }
    for (const draft of this.drafts.values()) if (draft.path === relative || draft.path.startsWith(`${relative}/`)) {
      draft.path = result + draft.path.slice(relative.length);
      draft.persisted = false;
      await this.persistDraft(draft).catch(() => this.privateChanged());
    }
    this.notify();
    return result;
  }

  renameEntry(input: string, name: string): Promise<string> {
    return this.serialized(() => this.relocate(input, path.posix.dirname(this.relative(input)) === '.' ? '' : path.posix.dirname(input), name));
  }

  moveEntry(input: string, destinationFolder: string): Promise<string> {
    return this.serialized(() => this.relocate(input, this.relative(destinationFolder, true)));
  }

  trashEntry(input: string): Promise<void> {
    return this.serialized(async () => {
      const relative = this.relative(input);
      const absolute = await this.resolve(relative);
      const stat = await fs.stat(absolute);
      if (!stat.isDirectory() && (!stat.isFile() || !isNotePath(relative))) fail('Solo se pueden enviar a la papelera notas Markdown, HTML y carpetas.');
      if (!this.options.trash) fail('La papelera no está disponible.');
      const trash = async () => {
        await this.resolve(relative);
        await this.options.trash!(absolute);
      };
      if (stat.isDirectory()) await this.relocateDirectory(trash);
      else await trash();
      this.notify();
    });
  }
}
