import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import { decryptEnvelope, encryptEnvelope, MAX_PRIVATE_BYTES, parseEnvelope, parseMetadata, unwrapKey, wrapKey, type PrivateMetadata } from './crypto';
import { rewriteWikiLinks } from '../shared/linkUpdates';
import { counterpartPaths, initialNoteContent, isNotePath, noteFormat, stripNoteExtension, withNoteExtension, type NoteFormat } from '../shared/notes';
import type { NoteDocument, PrivateDraftInfo, PrivateSessionStatus, VaultEntry, VaultInfo } from '../shared/types';

export const PRIVATE_CHILD = '.black-cobble-private';
/** The complete JSON tree, note bodies and recovery drafts must fit in 16 MiB. */
export const MAX_VAULT_BYTES = MAX_PRIVATE_BYTES;
type Options = { watch?: boolean; onChange?: () => void; onPrivateSessionChanged?: (status: PrivateSessionStatus) => void };
type Note = { id: string; path: string; content: string; revision: number };
type Draft = { id: string; path: string; content: string; expectedVersion: string; revision: number; updatedAt: number };
type Snapshot = { version: 1; folders: string[]; notes: Note[]; drafts: Draft[] };
type Container = { version: 1; metadata: PrivateMetadata; envelope: string };
const empty = (): Snapshot => ({ version: 1, folders: [], notes: [], drafts: [] });
function fail(message: string): never { throw new Error(message); }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const noteVersion = (note: Note): string => hash(JSON.stringify([note.id, note.revision, note.content]));
const locked = 'La bóveda privada está bloqueada o la sesión ha caducado.';

function relative(value: string, root = false): string {
  if (typeof value !== 'string' || (!value && !root) || value.includes('\\') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail('Ruta no válida.');
  if (!value && root) return '';
  if (value.split('/').some(part => !part || part.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) fail('Ruta no válida.');
  return value;
}
function name(value: string, note = false, format: NoteFormat = 'md'): string {
  if (typeof value !== 'string') fail('Nombre no válido.');
  let result = relative(value.trim());
  if (result.includes('/') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) fail('Nombre no válido.');
  if (note) result = withNoteExtension(result, format);
  if (Buffer.byteLength(result) > 240) fail('El nombre es demasiado largo.');
  return result;
}
function decode(bytes: Buffer): Container {
  if (bytes.length > MAX_VAULT_BYTES * 2) fail('La bóveda cifrada supera el límite de tamaño.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Container;
  if (!value || value.version !== 1 || Object.keys(value).sort().join() !== 'envelope,metadata,version' || typeof value.envelope !== 'string') fail('La bóveda cifrada está dañada.');
  value.metadata = parseMetadata(Buffer.from(JSON.stringify(value.metadata)));
  const envelope = parseEnvelope(Buffer.from(value.envelope));
  if (envelope.vaultId !== value.metadata.vaultId || envelope.noteId !== value.metadata.vaultId || envelope.purpose !== 'note') fail('La bóveda cifrada está dañada.');
  return value;
}
function snapshot(text: string): Snapshot {
  const value = JSON.parse(text) as Snapshot;
  if (!value || value.version !== 1 || !Array.isArray(value.folders) || !Array.isArray(value.notes) || !Array.isArray(value.drafts)) fail('La bóveda cifrada está dañada.');
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const folder of value.folders) { relative(folder); if (paths.has(folder.toLowerCase())) fail('Carpetas duplicadas.'); paths.add(folder.toLowerCase()); }
  for (const note of value.notes) {
    relative(note.path);
    if (!isNotePath(note.path) || typeof note.content !== 'string' || typeof note.id !== 'string' || ids.has(note.id) || !Number.isSafeInteger(note.revision) || note.revision < 0 || paths.has(note.path.toLowerCase())) fail('Notas cifradas dañadas.');
    paths.add(note.path.toLowerCase()); ids.add(note.id);
  }
  for (const item of [...value.folders, ...value.notes.map(note => note.path)]) { const parent = path.posix.dirname(item); if (parent !== '.' && !value.folders.includes(parent)) fail('Carpeta cifrada ausente.'); }
  const drafts = new Set<string>();
  for (const draft of value.drafts) {
    relative(draft.path);
    if (typeof draft.id !== 'string' || drafts.has(draft.id) || typeof draft.content !== 'string' || !/^[a-f0-9]{64}$/.test(draft.expectedVersion) || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || !Number.isSafeInteger(draft.updatedAt)) fail('Recuperación cifrada dañada.');
    drafts.add(draft.id);
  }
  return value;
}

/** A virtual filesystem. Only ciphertext and password-wrapped random keys reach disk. */
export class EncryptedVault {
  private root: string;
  private metadata?: PrivateMetadata;
  private stagedMetadata?: PrivateMetadata;
  private container?: Container;
  private diskVersion?: string;
  private key?: Buffer;
  private state?: Snapshot;
  private sid: string | null = null;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private disposed = false;
  private error?: string;
  private pending?: Buffer;
  private durable?: Buffer;
  private recoveryCount = 0;
  private durableRecoveryCount = 0;
  private pendingRecoveryCount = 0;
  private sealSequence = 0;
  private durableSequence = 0;
  private readonly sequences = new WeakMap<Buffer, number>();
  private recoveryFiles: string[] = [];
  /** Recovery files left sealed at unlock because their versions did not fit in the vault. */
  private deferredRecovery = 0;
  private readonly options: Options;
  constructor(root: string, options: Options = {}) { this.root = path.resolve(root); this.options = options; }
  get info(): VaultInfo { return { name: 'Privada', path: path.join(this.root, PRIVATE_CHILD), kind: 'private', parentPath: this.root }; }
  get file(): string { return path.join(this.root, PRIVATE_CHILD, 'vault.sealed'); }
  private queue<T>(operation: () => Promise<T>): Promise<T> { const result = this.tail.then(operation, operation); this.tail = result.catch(() => undefined); return result; }
  private changed(): void { if (!this.disposed) { this.options.onPrivateSessionChanged?.(this.getPrivateSession()); this.options.onChange?.(); } }
  private session(id: string | null | undefined = this.sid): Buffer { if (!id || id !== this.sid || !this.key || !this.state || !this.metadata || this.disposed || this.error) fail(this.error ?? locked); return this.key; }
  private async directory(create = false): Promise<void> {
    if ((await fs.realpath(this.root)) !== this.root || !(await fs.lstat(this.root)).isDirectory()) fail('La carpeta de la bóveda ha cambiado.');
    const child = path.join(this.root, PRIVATE_CHILD);
    if (create) await fs.mkdir(child, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(child); if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(child) !== child) fail('La carpeta privada debe ser una carpeta local sin enlaces.');
  }
  private async bytes(): Promise<Buffer> {
    await this.directory();
    const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VAULT_BYTES * 2) fail('El archivo de la bóveda privada no es válido.');
    const file = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { if ((await file.stat()).size > MAX_VAULT_BYTES * 2) fail('La bóveda privada supera el límite de tamaño.'); return await file.readFile(); } finally { await file.close(); }
  }
  async initialize(): Promise<void> {
    this.root = await fs.realpath(this.root);
    try { const bytes = await this.bytes(); this.container = decode(bytes); this.metadata = this.container.metadata; this.diskVersion = hash(bytes); this.durable = bytes; }
    catch (error) { if (!missing(error)) this.error = 'La bóveda privada está dañada o no está disponible. Conserva .black-cobble-private y restaura una copia de seguridad.'; }
    try { await this.directory(); this.recoveryFiles = (await fs.readdir(path.join(this.root, PRIVATE_CHILD))).filter(file => /^recovery-[0-9a-f-]+\.sealed$/.test(file)); this.recoveryCount = this.recoveryFiles.length; } catch { /* Missing/corrupt storage is handled above. */ }
    if (this.options.watch !== false) {
      this.watcher = chokidar.watch(path.join(this.root, PRIVATE_CHILD), { ignoreInitial: true, followSymlinks: false });
      this.watcher.on('all', (_event, candidate) => { if (path.resolve(candidate) === this.file && this.metadata) void this.queue(() => this.checkDisk()).catch(() => undefined); });
      this.watcher.on('error', () => { this.error = 'No se puede vigilar la bóveda privada.'; void this.lockPrivateSession(); });
    }
  }
  getPrivateSession(): PrivateSessionStatus { return { configured: !!this.metadata, unlocked: !!this.key && !!this.sid, sessionId: this.sid, vaultPath: this.root, recoveryCount: this.recoveryCount, memoryOnlyDrafts: !!this.pending, ...(this.key && this.sid && this.deferredRecovery ? { recoveryPending: this.deferredRecovery } : {}), ...(this.error ? { error: this.error } : {}) }; }
  private encode(state: Snapshot, metadata = this.stagedMetadata ?? this.metadata!, key = this.session()): Buffer {
    const text = JSON.stringify(state); if (Buffer.byteLength(text) > MAX_VAULT_BYTES) fail('La bóveda privada admite hasta 16 MiB de notas, carpetas y borradores en total.');
    const bytes = Buffer.from(JSON.stringify({ version: 1, metadata, envelope: encryptEnvelope(key, metadata.vaultId, metadata.vaultId, text).toString('utf8') } satisfies Container));
    this.sequences.set(bytes, ++this.sealSequence); return bytes;
  }
  private async checkDisk(): Promise<void> {
    if (!this.diskVersion) return;
    try { if (hash(await this.bytes()) !== this.diskVersion) fail('changed'); }
    catch { this.error = 'CONFLICT: La bóveda privada ha cambiado o no está disponible. Reabre la bóveda y conserva los cambios pendientes.'; void this.lockPrivateSession(); fail(this.error); }
  }
  private stage(state: Snapshot): Buffer { const bytes = this.encode(state); this.state = state; this.pending = bytes; this.pendingRecoveryCount = state.drafts.length; this.recoveryCount = state.drafts.length; this.changed(); return bytes; }
  private renameFile(temp: string): Promise<void> { return fs.rename(temp, this.file); }
  private async replaceSnapshot(temp: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.directory(); await this.checkDisk();
      try { await this.renameFile(temp); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error;
        // Windows antivirus/indexers can temporarily hold a rename target.
        // Recheck the expected ciphertext before every bounded retry.
        await new Promise<void>(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  private async persist(bytes: Buffer, exclusive = false, count = this.pendingRecoveryCount): Promise<void> {
    const sequence = this.sequences.get(bytes) ?? 0;
    // A synchronous draft can enter behind a queued mutation whose eventual
    // snapshot already includes it. Never replace that newer durable snapshot.
    if (sequence && sequence <= this.durableSequence) return;
    await this.directory(exclusive);
    const temp = path.join(this.root, PRIVATE_CHILD, `.sealed-${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temp, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await this.directory();
      if (exclusive) { await fs.link(temp, this.file); await fs.unlink(temp); }
      else await this.replaceSnapshot(temp);
      this.diskVersion = hash(bytes); this.durable = bytes; this.durableRecoveryCount = count; this.durableSequence = sequence; this.container = decode(bytes); this.metadata = this.container.metadata;
      if (this.pending === bytes) this.pending = undefined;
      this.changed();
    } finally { await fs.unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
  }
  setupPrivateSession(password: string): Promise<PrivateSessionStatus> {
    const generation = this.generation;
    return this.queue(async () => {
      if (this.metadata || this.error) fail(this.error ?? 'El cifrado ya está configurado.');
      // Any unexpected child content needs explicit recovery, never overwrite it.
      try { await this.directory(); if ((await fs.readdir(path.join(this.root, PRIVATE_CHILD))).length) fail('La carpeta privada contiene datos. Conserva esos archivos y restaura la bóveda.'); } catch (error) { if (!missing(error)) throw error; }
      const key = randomBytes(32);
      try {
        const metadata = await wrapKey(password, key); if (generation !== this.generation || this.disposed) fail(locked);
        const state = empty(); const bytes = this.encode(state, metadata, key); await this.persist(bytes, true, 0);
        if (generation !== this.generation || this.disposed) fail(locked);
        this.key = Buffer.from(key); this.sid = randomUUID(); this.state = state; this.changed(); return this.getPrivateSession();
      } finally { key.fill(0); }
    });
  }
  unlockPrivateSession(password: string): Promise<PrivateSessionStatus> {
    const generation = this.generation;
    return this.queue(async () => {
      if (!this.metadata || this.error) fail(this.error ?? 'Configura primero la bóveda privada.');
      if (this.pending) fail('Hay cambios privados sin guardar. Reintenta guardarlos o descártalos antes de desbloquear.');
      await this.checkDisk(); const bytes = await this.bytes(); const container = decode(bytes); const key = await unwrapKey(password, container.metadata);
      try {
        await this.checkDisk(); if (generation !== this.generation || this.disposed) fail(locked);
        const state = snapshot(decryptEnvelope(key, parseEnvelope(Buffer.from(container.envelope)), container.metadata.vaultId));
        // Renderer revision counters restart for each session.
        for (const draft of state.drafts) draft.revision = 0;
        const imported: string[] = []; let added = 0;
        // Recovered versions join only while the vault still fits; a file is deleted once all of its versions joined.
        // The rest stays sealed on disk, so unlocking never fails because recovery is large.
        let size = Buffer.byteLength(JSON.stringify(state));
        const add = (draft: Draft): boolean => {
          const extra = Buffer.byteLength(JSON.stringify(draft)) + 1;
          if (size + extra > MAX_VAULT_BYTES) return false;
          state.drafts.push(draft); size += extra; added++; return true;
        };
        for (const filename of this.recoveryFiles) {
          const recoveryPath = path.join(this.root, PRIVATE_CHILD, filename); const stat = await fs.lstat(recoveryPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VAULT_BYTES * 2) fail('El archivo de recuperación privada no es válido.');
          const recovery = decode(await fs.readFile(recoveryPath)); if (recovery.metadata.vaultId !== container.metadata.vaultId) fail('La recuperación cifrada pertenece a otra bóveda. Conserva el archivo y recupéralo en su bóveda original.'); const recoveryKey = await unwrapKey(password, recovery.metadata);
          try {
            const saved = snapshot(decryptEnvelope(recoveryKey, parseEnvelope(Buffer.from(recovery.envelope)), recovery.metadata.vaultId));
            let complete = true;
            for (const note of saved.notes) if (!state.notes.some(current => current.path === note.path && current.content === note.content) && !state.drafts.some(current => current.path === note.path && current.content === note.content)) complete = add({ id: randomUUID(), path: note.path, content: note.content, expectedVersion: noteVersion(note), revision: 0, updatedAt: Date.now() }) && complete;
            for (const draft of saved.drafts) if (!state.drafts.some(current => current.path === draft.path && current.content === draft.content)) complete = add({ ...draft, id: randomUUID() }) && complete;
            if (complete) imported.push(filename);
          } finally { recoveryKey.fill(0); }
        }
        if (generation !== this.generation || this.disposed) fail(locked);
        this.key?.fill(0); this.key = Buffer.from(key); this.state = state; this.sid = randomUUID(); this.stagedMetadata = container.metadata; this.recoveryCount = state.drafts.length; this.durableRecoveryCount = state.drafts.length;
        if (added || imported.length) {
          try {
            const sealed = this.stage(state); await this.persist(sealed, false, state.drafts.length);
            for (const filename of imported) await fs.unlink(path.join(this.root, PRIVATE_CHILD, filename));
            this.recoveryFiles = this.recoveryFiles.filter(filename => !imported.includes(filename)); this.session(this.sid);
          } catch (error) { void this.lockPrivateSession(); throw error; }
        }
        this.deferredRecovery = this.recoveryFiles.length;
        this.changed(); return this.getPrivateSession();
      } finally { key.fill(0); }
    });
  }
  lockPrivateSession(): Promise<PrivateSessionStatus> {
    // Seal accepted drafts synchronously before revocation. No filenames or bodies
    // remain in this instance after state is dropped, even if disk I/O stalls.
    if (this.key && this.state && !this.error) {
      try {
        const next = structuredClone(this.state);
        next.drafts = next.drafts.filter(draft => { const note = next.notes.find(item => item.path === draft.path); if (!note || noteVersion(note) !== draft.expectedVersion) return true; note.content = draft.content; note.revision++; return false; });
        if (next.drafts.length !== this.state.drafts.length) this.stage(next);
      } catch { /* Existing sealed recovery bytes still protect accepted drafts. */ }
    }
    this.generation++; this.sid = null; this.key?.fill(0); this.key = undefined; this.state = undefined; this.changed();
    return this.queue(async () => { if (this.pending && !this.error) { try { await this.persist(this.pending); } catch { /* Retain only sealed bytes for close-time retry. */ } } return this.getPrivateSession(); });
  }
  async dispose(): Promise<void> { await this.lockPrivateSession(); this.disposed = true; await this.tail; await this.watcher?.close(); }
  private async view(id: string | null): Promise<Snapshot> { this.session(id); await this.checkDisk(); this.session(id); return this.state!; }
  private note(state: Snapshot, input: string): Note { relative(input); const note = state.notes.find(item => item.path === input); if (!note) fail('CONFLICT: La nota no existe o se ha movido.'); return note; }
  private document(note: Note, id = this.sid!): NoteDocument { return { path: note.path, content: note.content, version: noteVersion(note), encrypted: true, locked: false, sessionId: id }; }
  private folder(state: Snapshot, input: string): void { relative(input, true); if (input && !state.folders.includes(input)) fail('La carpeta de destino no existe.'); }
  private unused(state: Snapshot, input: string, except?: string, note = false): void {
    const taken = (candidate: string) => [...state.folders, ...state.notes.map(item => item.path)].some(item => item !== except && item.toLowerCase() === candidate.toLowerCase());
    if (taken(input)) fail('Ya existe una nota o carpeta con ese nombre.');
    // Nota.md and Nota.html side by side would make [[Nota]] ambiguous.
    if (note && counterpartPaths(input).some(taken)) fail('Ya existe una nota con ese nombre en otro formato.');
  }
  private mutate<T>(id: string | null, action: (state: Snapshot) => T): Promise<T> {
    return this.queue(async () => { const state = structuredClone(await this.view(id)); const result = action(state); const bytes = this.stage(state); const count = state.drafts.length; await this.persist(bytes, false, count); this.session(id); return result; });
  }
  listEntries(): Promise<VaultEntry[]> {
    const id = this.sid;
    if (!id) return Promise.resolve([]);
    return this.queue(async () => {
      const state = await this.view(id);
      const visit = (parent: string): VaultEntry[] => [
        ...state.folders.filter(item => (path.posix.dirname(item) === '.' ? '' : path.posix.dirname(item)) === parent).map(item => ({ name: path.posix.basename(item), path: item, type: 'folder' as const, children: visit(item) })),
        ...state.notes.filter(note => (path.posix.dirname(note.path) === '.' ? '' : path.posix.dirname(note.path)) === parent).map(note => ({ name: path.posix.basename(note.path), path: note.path, type: 'file' as const, encrypted: true })),
      ].sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
      return visit('');
    });
  }
  readNote(input: string): Promise<NoteDocument> { const id = this.sid; return this.queue(async () => this.document(this.note(await this.view(id), input), id!)); }
  writeNote(input: string, content: string, expectedVersion: string, id?: string): Promise<NoteDocument> {
    return this.mutate(id ?? null, state => { const note = this.note(state, input); if (noteVersion(note) !== expectedVersion) fail('CONFLICT: La nota ha cambiado.'); this.text(content); note.content = content; note.revision++; state.drafts = state.drafts.filter(draft => draft.path !== input || draft.content !== content); return this.document(note, id!); });
  }
  private text(content: string): void { if (typeof content !== 'string' || Buffer.from(content).toString('utf8') !== content) fail('El texto contiene caracteres no válidos.'); }
  private addNote(state: Snapshot, parent: string, title: string, content: string): Note { this.folder(state, parent); this.text(content); const filename = name(title, true); const input = parent ? `${parent}/${filename}` : filename; this.unused(state, input, undefined, true); const note = { id: randomUUID(), path: input, content, revision: 0 }; state.notes.push(note); return note; }
  createNote(parent: string, title: string, format: NoteFormat = 'md'): Promise<NoteDocument> {
    if (format !== 'md' && format !== 'html') return Promise.reject(new Error('Formato de nota no válido.'));
    const id = this.sid;
    return this.mutate(id, state => { const filename = name(title, true, format); return this.document(this.addNote(state, parent, filename, initialNoteContent(filename)), id!); });
  }
  createPrivateCopy(parent: string, title: string, content: string, id: string): Promise<NoteDocument> { return this.mutate(id, state => this.document(this.addNote(state, parent, title, content), id)); }
  createFolder(parent: string, title: string): Promise<string> { return this.mutate(this.sid, state => { this.folder(state, parent); const input = parent ? `${parent}/${name(title)}` : name(title); this.unused(state, input); state.folders.push(input); return input; }); }
  private relocate(input: string, parent: string, title?: string): Promise<string> {
    return this.mutate(this.sid, state => {
      relative(input); this.folder(state, parent); const isFolder = state.folders.includes(input); if (!isFolder) this.note(state, input);
      const filename = title === undefined ? path.posix.basename(input) : name(title, !isFolder, noteFormat(input) ?? 'md'); const target = parent ? `${parent}/${filename}` : filename;
      if (!isFolder && noteFormat(filename) !== noteFormat(input)) fail('No se puede cambiar el formato de una nota al renombrarla.');
      if (target === input) return input; if (isFolder && (target.startsWith(`${input}/`) || parent === input)) fail('No puedes mover una carpeta dentro de sí misma.'); this.unused(state, target, input, !isFolder);
      const before = state.notes.map(note => note.path); const versionsBefore = new Map(state.notes.map(note => [note.path, noteVersion(note)])); const mapping = new Map<string, string>();
      for (const item of [...state.folders, ...before]) if (item === input || item.startsWith(`${input}/`)) mapping.set(item, target + item.slice(input.length));
      state.folders = state.folders.map(item => mapping.get(item) ?? item);
      for (const note of state.notes) { const old = note.path; note.path = mapping.get(old) ?? old; const content = rewriteWikiLinks(note.content, old, note.path, before, mapping); if (content !== note.content) { note.content = content; note.revision++; } }
      for (const draft of state.drafts) { const old = draft.path; draft.path = mapping.get(old) ?? old; draft.content = rewriteWikiLinks(draft.content, old, draft.path, before, mapping); if (draft.expectedVersion === versionsBefore.get(old)) { const note = state.notes.find(item => item.path === draft.path); if (note) draft.expectedVersion = noteVersion(note); } }
      return target;
    });
  }
  renameEntry(input: string, title: string): Promise<string> { return this.relocate(input, path.posix.dirname(input) === '.' ? '' : path.posix.dirname(input), title); }
  moveEntry(input: string, destination: string): Promise<string> { return this.relocate(input, destination); }
  trashEntry(input: string): Promise<void> {
    return this.mutate(this.sid, state => {
      relative(input); if (!state.folders.includes(input)) this.note(state, input);
      state.folders = state.folders.filter(item => item !== input && !item.startsWith(`${input}/`)); state.notes = state.notes.filter(item => item.path !== input && !item.path.startsWith(`${input}/`));
      state.drafts = state.drafts.filter(item => item.path !== input && !item.path.startsWith(`${input}/`));
    });
  }
  savePrivateDraft(input: string, content: string, expectedVersion: string, revision: number, id: string): Promise<void> {
    // Accept and seal before entering the queue, so an immediate lock can preserve it.
    this.session(id); this.text(content); if (!Number.isSafeInteger(revision) || revision < 0 || !/^[a-f0-9]{64}$/.test(expectedVersion)) return Promise.reject(new Error('Borrador no válido.'));
    const state = structuredClone(this.state!); const note = this.note(state, input); const previous = state.drafts.find(draft => draft.id === note.id);
    if (previous && previous.revision > revision) return Promise.resolve();
    state.drafts = state.drafts.filter(draft => draft.id !== note.id); state.drafts.push({ id: note.id, path: input, content, expectedVersion, revision, updatedAt: Date.now() }); const bytes = this.stage(state); const count = state.drafts.length;
    return this.queue(async () => { await this.persist(bytes, false, count); });
  }
  listPrivateDrafts(id: string): Promise<PrivateDraftInfo[]> { return this.queue(async () => (await this.view(id)).drafts.map(draft => ({ id: draft.id, path: draft.path, updatedAt: draft.updatedAt }))); }
  discardPrivateDraft(input: string, id: string): Promise<void> { return this.mutate(id, state => { if (!state.drafts.some(draft => draft.id === input)) fail('El borrador no existe.'); state.drafts = state.drafts.filter(draft => draft.id !== input); }); }
  recoverPrivateDraft(input: string, id: string): Promise<NoteDocument> { return this.mutate(id, state => { const draft = state.drafts.find(item => item.id === input); if (!draft) fail('El borrador no existe.'); const note = this.addNote(state, '', withNoteExtension(`${stripNoteExtension(path.posix.basename(draft.path))} recuperado ${randomUUID().slice(0, 8)}`, noteFormat(draft.path) ?? 'md'), draft.content); state.drafts = state.drafts.filter(item => item.id !== input); return this.document(note, id); }); }
  private async preserveRecovery(bytes: Buffer): Promise<void> {
    await this.directory(); const filename = `recovery-${randomUUID()}.sealed`; const target = path.join(this.root, PRIVATE_CHILD, filename); const temp = path.join(this.root, PRIVATE_CHILD, `.sealed-${randomUUID()}.tmp`);
    try { const file = await fs.open(temp, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } await this.directory(); await fs.link(temp, target); this.recoveryFiles.push(filename); if (this.pending === bytes) { this.pending = undefined; this.recoveryCount = Math.max(1, this.recoveryCount); } this.changed(); }
    finally { await fs.unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
  }
  retryPersistPrivateDrafts(): Promise<boolean> { return this.queue(async () => { if (this.pending) { try { await this.persist(this.pending); } catch { if (this.error && this.pending) { try { await this.preserveRecovery(this.pending); } catch { /* Keep sealed memory when storage is unavailable. */ } } } } return !this.pending; }); }
  discardMemoryPrivateDrafts(): void { this.pending = undefined; this.recoveryCount = this.durableRecoveryCount; if (this.durable) { const container = decode(this.durable); this.metadata = container.metadata; this.stagedMetadata = container.metadata; if (this.key) this.state = snapshot(decryptEnvelope(this.key, parseEnvelope(Buffer.from(container.envelope)), this.metadata.vaultId)); } this.changed(); }
  changePrivatePassword(currentPassword: string, newPassword: string, id: string): Promise<void> {
    return this.queue(async () => { await this.view(id); const key = await unwrapKey(currentPassword, this.metadata!); try { this.session(id); const metadata = await wrapKey(newPassword, key, this.metadata!.vaultId); this.session(id); const bytes = this.encode(this.state!, metadata); this.stagedMetadata = metadata; this.pending = bytes; this.pendingRecoveryCount = this.state!.drafts.length; await this.persist(bytes); this.session(id); } finally { key.fill(0); } });
  }
}
