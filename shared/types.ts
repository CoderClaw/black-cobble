import type { NoteFormat } from './notes';
import type { ReplaceOutcome, ReplaceTarget, SearchOptions, SearchResult } from './search';

export interface VaultInfo { name: string; path: string; kind?: 'normal' | 'private'; parentPath?: string }
export interface VaultEntry { name: string; path: string; type: 'file' | 'folder'; children?: VaultEntry[]; encrypted?: boolean }
export interface NoteDocument { path: string; content: string; version: string; encrypted?: boolean; locked?: boolean; sessionId?: string }
export interface PrivateSessionStatus { configured: boolean; unlocked: boolean; sessionId: string | null; vaultPath: string; recoveryCount: number; memoryOnlyDrafts: boolean; recoveryPending?: number; error?: string }
export interface PrivateDraftInfo { id: string; path: string; updatedAt: number }
export interface VaultAPI {
  getVault(): Promise<VaultInfo | null>;
  openVault(): Promise<VaultInfo | null>;
  selectVaultMode(mode: 'normal' | 'private'): Promise<VaultInfo>;
  listEntries(): Promise<VaultEntry[]>;
  readNote(path: string): Promise<NoteDocument>;
  writeNote(path: string, content: string, expectedVersion: string, sessionId?: string): Promise<NoteDocument>;
  createNote(parent: string, name: string, format?: NoteFormat): Promise<NoteDocument>;
  createFolder(parent: string, name: string): Promise<string>;
  renameEntry(path: string, name: string): Promise<string>;
  moveEntry(path: string, destinationFolder: string): Promise<string>;
  trashEntry(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Scans the active vault; a private vault needs its session id. Invalid regexes reject with a Spanish message. */
  searchNotes(options: SearchOptions, sessionId?: string): Promise<SearchResult>;
  /** Re-matches each target at its expected version and rewrites it; conflicts are reported per file. */
  replaceInNotes(options: SearchOptions, replacement: string, targets: ReplaceTarget[], sessionId?: string): Promise<ReplaceOutcome[]>;
  onVaultChanged(callback: () => void): () => void;
  onBeforeClose(callback: () => void): () => void;
  confirmClose(): void;
  getPrivateSession(): Promise<PrivateSessionStatus>;
  setupPrivateSession(password: string): Promise<PrivateSessionStatus>;
  unlockPrivateSession(password: string): Promise<PrivateSessionStatus>;
  lockPrivateSession(): Promise<PrivateSessionStatus>;
  changePrivatePassword(currentPassword: string, newPassword: string, sessionId: string): Promise<void>;
  setNotePrivate(path: string, content: string, expectedVersion: string, encrypted: boolean, sessionId: string): Promise<NoteDocument>;
  savePrivateDraft(path: string, content: string, expectedVersion: string, revision: number, sessionId: string): Promise<void>;
  listPrivateDrafts(sessionId: string): Promise<PrivateDraftInfo[]>;
  recoverPrivateDraft(id: string, sessionId: string): Promise<NoteDocument>;
  discardPrivateDraft(id: string, sessionId: string): Promise<void>;
  createPrivateCopy(parent: string, name: string, content: string, sessionId: string): Promise<NoteDocument>;
  privateActivity(): void;
  acknowledgePrivateLock(): void;
  onPrivateSessionChanged(callback: (status: PrivateSessionStatus) => void): () => void;
}
declare global { interface Window { vault: VaultAPI } }
