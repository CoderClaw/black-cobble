import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EncryptedVault, PRIVATE_CHILD } from './encrypted-vault';
import { VaultService } from './storage';
import { isPrivateBytes } from './crypto';
import { isNotePath, type NoteFormat } from '../shared/notes';
import type { ReplaceOutcome, ReplaceTarget, SearchOptions, SearchResult } from '../shared/search';
import type { NoteDocument, PrivateDraftInfo, PrivateSessionStatus, VaultEntry, VaultInfo } from '../shared/types';

type StorageOptions = ConstructorParameters<typeof VaultService>[1];
const legacyMessage = 'Hay notas privadas del formato anterior. Ábrelas con la versión anterior, exporta sus notas y borradores, y conserva una copia antes de retirar .black-cobble/private.json. Después configura la bóveda privada nueva e importa esa copia. Los archivos originales se conservan.';

/** Normal Markdown/HTML files and an independent encrypted child share one workspace. */
export class VaultWorkspace {
  private readonly normal: VaultService;
  private privateVault?: EncryptedVault;
  private mode: 'normal' | 'private' = 'normal';
  private legacy = false;
  private readonly options: NonNullable<StorageOptions>;
  constructor(root: string, options: StorageOptions = {}) {
    if (path.basename(path.resolve(root)).toLowerCase() === PRIVATE_CHILD) throw new Error('Abre la carpeta principal de la bóveda, no .black-cobble-private.');
    this.options = options;
    this.normal = new VaultService(root, { ...options, onPrivateSessionChanged: () => this.publish() });
  }
  async initialize(): Promise<VaultInfo> {
    const normal = await this.normal.initialize();
    if (path.basename(normal.path).toLowerCase() === PRIVATE_CHILD) throw new Error('Abre la carpeta principal de la bóveda, no .black-cobble-private.');
    try { await fs.lstat(path.join(normal.path, 'vault.sealed')); throw new Error('Esta carpeta contiene una bóveda cifrada. Abre su carpeta principal.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.legacy = this.normal.getPrivateSession().configured || !!this.normal.getPrivateSession().error;
    // Preserve orphaned legacy recovery records too. Hidden names are never listed.
    try { if ((await fs.readdir(path.join(normal.path, '.black-cobble', 'drafts'))).length) this.legacy = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.legacy = true; }
    this.privateVault = new EncryptedVault(normal.path, { watch: this.options.watch, onChange: this.options.onChange, onPrivateSessionChanged: () => this.publish(), search: this.options.search });
    await this.privateVault.initialize(); return this.info;
  }
  private get private(): EncryptedVault { if (!this.privateVault) throw new Error('La bóveda todavía no está abierta.'); return this.privateVault; }
  private get active(): VaultService | EncryptedVault { return this.mode === 'private' ? this.private : this.normal; }
  get info(): VaultInfo { return this.mode === 'private' ? this.private.info : { ...this.normal.info, kind: 'normal' }; }
  async selectMode(mode: 'normal' | 'private'): Promise<VaultInfo> { if (mode !== 'normal' && mode !== 'private') throw new Error('Bóveda no válida.'); if (mode === 'normal') { await this.private.lockPrivateSession(); if (this.getPrivateSession().memoryOnlyDrafts) throw new Error('Hay cambios privados sin guardar. Reintenta guardarlos antes de cambiar de bóveda.'); } this.mode = mode; this.options.onChange?.(); return this.info; }
  private publish(): void { if (this.privateVault) this.options.onPrivateSessionChanged?.(this.getPrivateSession()); }
  getPrivateSession(): PrivateSessionStatus { const status = this.privateVault?.getPrivateSession() ?? { configured: false, unlocked: false, sessionId: null, vaultPath: this.normal.info.path, recoveryCount: 0, memoryOnlyDrafts: false }; return this.legacy ? { ...status, error: legacyMessage } : status; }
  private checkLegacy(): void { if (this.legacy) throw new Error(legacyMessage); }
  private async checkOrphans(): Promise<void> {
    if (this.legacy) return;
    const visit = async (relative = ''): Promise<boolean> => {
      for (const item of await fs.readdir(path.join(this.normal.info.path, relative), { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const input = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory() && await visit(input)) return true;
        if (item.isFile() && isNotePath(item.name)) {
          const file = await fs.open(path.join(this.normal.info.path, input), 'r');
          try { const prefix = Buffer.alloc(48); const { bytesRead } = await file.read(prefix, 0, prefix.length, 0); if (isPrivateBytes(prefix.subarray(0, bytesRead))) return true; } finally { await file.close(); }
        }
      }
      return false;
    };
    if (await visit()) { this.legacy = true; this.publish(); }
  }
  async setupPrivateSession(password: string): Promise<PrivateSessionStatus> { await this.checkOrphans(); this.checkLegacy(); return this.private.setupPrivateSession(password); }
  async unlockPrivateSession(password: string): Promise<PrivateSessionStatus> { this.checkLegacy(); return this.private.unlockPrivateSession(password); }
  lockPrivateSession(): Promise<PrivateSessionStatus> { return this.privateVault?.lockPrivateSession() ?? Promise.resolve(this.getPrivateSession()); }
  changePrivatePassword(current: string, next: string, id: string): Promise<void> { this.checkLegacy(); return this.private.changePrivatePassword(current, next, id); }
  retryPersistPrivateDrafts(): Promise<boolean> { return this.private.retryPersistPrivateDrafts(); }
  discardMemoryPrivateDrafts(): void { this.private.discardMemoryPrivateDrafts(); }
  listEntries(): Promise<VaultEntry[]> { return this.active.listEntries(); }
  private route(...inputs: string[]): void { for (const input of inputs) if (typeof input !== 'string' || input.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('Las carpetas internas no son rutas de notas.'); }
  readNote(input: string): Promise<NoteDocument> { this.route(input); return this.active.readNote(input); }
  writeNote(input: string, content: string, expectedVersion: string, id?: string): Promise<NoteDocument> { this.route(input); if (this.mode === 'normal' && id) return Promise.reject(new Error('La sesión pertenece a la bóveda privada.')); return this.active.writeNote(input, content, expectedVersion, id); }
  searchNotes(options: SearchOptions, id?: string): Promise<SearchResult> { return this.mode === 'private' ? this.private.searchNotes(options, id) : id ? Promise.reject(new Error('La sesión pertenece a la bóveda privada.')) : this.normal.searchNotes(options); }
  replaceInNotes(options: SearchOptions, replacement: string, targets: ReplaceTarget[], id?: string): Promise<ReplaceOutcome[]> {
    if (!Array.isArray(targets)) return Promise.reject(new Error('Argumento no válido.'));
    this.route(...targets.map(target => target?.path));
    return this.mode === 'private' ? this.private.replaceInNotes(options, replacement, targets, id) : id ? Promise.reject(new Error('La sesión pertenece a la bóveda privada.')) : this.normal.replaceInNotes(options, replacement, targets);
  }
  createNote(parent: string, name: string, format?: NoteFormat): Promise<NoteDocument> { this.route(parent); return this.active.createNote(parent, name, format); }
  createFolder(parent: string, name: string): Promise<string> { this.route(parent); return this.active.createFolder(parent, name); }
  renameEntry(input: string, name: string): Promise<string> { this.route(input); return this.active.renameEntry(input, name); }
  moveEntry(input: string, parent: string): Promise<string> { this.route(input, parent); return this.active.moveEntry(input, parent); }
  trashEntry(input: string): Promise<void> { this.route(input); return this.active.trashEntry(input); }
  setNotePrivate(_input: string, _content: string, _expectedVersion: string, _encrypted: boolean, _id: string): Promise<NoteDocument> { return Promise.reject(new Error('El cifrado se aplica a toda la bóveda privada. Cambia a Privada para crear o importar notas allí.')); }
  private requirePrivateMode(): void { if (this.mode !== 'private') throw new Error('Cambia a la bóveda privada para guardar contenido privado.'); }
  savePrivateDraft(input: string, content: string, expectedVersion: string, revision: number, id: string): Promise<void> { this.requirePrivateMode(); return this.private.savePrivateDraft(input, content, expectedVersion, revision, id); }
  createPrivateCopy(parent: string, name: string, content: string, id: string): Promise<NoteDocument> { this.requirePrivateMode(); return this.private.createPrivateCopy(parent, name, content, id); }
  listPrivateDrafts(id: string): Promise<PrivateDraftInfo[]> { this.requirePrivateMode(); return this.private.listPrivateDrafts(id); }
  recoverPrivateDraft(input: string, id: string): Promise<NoteDocument> { this.requirePrivateMode(); return this.private.recoverPrivateDraft(input, id); }
  discardPrivateDraft(input: string, id: string): Promise<void> { return this.private.discardPrivateDraft(input, id); }
  async dispose(): Promise<void> { await this.privateVault?.dispose(); await this.normal.dispose(); }
}
