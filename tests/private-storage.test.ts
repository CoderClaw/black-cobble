import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultService } from '../electron/storage';
import { PRIVATE_HEADER } from '../electron/crypto';

let root: string; let vault: VaultService; const services: VaultService[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'black-cobble-private-'));
  vault = new VaultService(root, { watch: false }); services.push(vault); await vault.initialize();
});
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await fs.rm(root, { recursive: true, force: true }); });
async function privateNote(content = 'Synthetic secret 日本語 🙂') {
  const status = await vault.setupPrivateSession('synthetic password'); const sid = status.sessionId!;
  const original = await vault.createNote('', 'Privada');
  const note = await vault.setNotePrivate(original.path, content, original.version, true, sid);
  return { note, sid };
}
async function reopen() { await vault.dispose(); vault = new VaultService(root, { watch: false }); services.push(vault); await vault.initialize(); }

describe('private vault storage', () => {
  it('encrypts latest content directly and locked reads never expose ciphertext or plaintext', async () => {
    const { note, sid } = await privateNote('\ufeff# Último borrador\nSynthetic content');
    const bytes = await fs.readFile(path.join(root, note.path), 'utf8');
    expect(bytes.startsWith(PRIVATE_HEADER)).toBe(true); expect(bytes).not.toContain('Synthetic content');
    expect((await vault.listEntries())[0].encrypted).toBe(true);
    await vault.lockPrivateSession();
    expect(await vault.readNote(note.path)).toEqual({ path: note.path, version: note.version, content: '', encrypted: true, locked: true });
    await expect(vault.writeNote(note.path, 'stale', note.version, sid)).rejects.toThrow();
    await expect(vault.unlockPrivateSession('wrong')).rejects.toThrow();
    const unlocked = await vault.unlockPrivateSession('synthetic password');
    expect((await vault.readNote(note.path)).content).toBe(note.content);
    const publicNote = await vault.setNotePrivate(note.path, note.content, note.version, false, unlocked.sessionId!);
    expect(await fs.readFile(path.join(root, note.path), 'utf8')).toBe(note.content); expect(publicNote.encrypted).toBeUndefined();
  });
  it('keeps encrypted bytes through rename/folder moves and password changes', async () => {
    const { note, sid } = await privateNote(); const before = await fs.readFile(path.join(root, note.path));
    await vault.createFolder('', 'Destino'); const renamed = await vault.renameEntry(note.path, 'Otra');
    const moved = await vault.moveEntry(renamed, 'Destino');
    expect((await fs.readFile(path.join(root, moved))).equals(before)).toBe(true);
    await expect(vault.changePrivatePassword('wrong', 'new password', sid)).rejects.toThrow();
    await vault.changePrivatePassword('synthetic password', 'new password', sid);
    expect((await fs.readFile(path.join(root, moved))).equals(before)).toBe(true);
    await reopen(); await expect(vault.unlockPrivateSession('synthetic password')).rejects.toThrow();
    await vault.unlockPrivateSession('new password'); expect((await vault.readNote(moved)).content).toBe(note.content);
  });
  it('durably journals snapshots without changing note versions, recovers distinct private notes after restart', async () => {
    const { note, sid } = await privateNote();
    await vault.savePrivateDraft(note.path, 'Synthetic recovery secret', note.version, 1, sid);
    expect((await vault.readNote(note.path)).version).toBe(note.version);
    const id = (await vault.listPrivateDrafts(sid))[0].id;
    const journal = await fs.readFile(path.join(root, '.black-cobble/drafts', `${id}.json`), 'utf8');
    expect(journal).not.toContain('Synthetic recovery secret');
    await fs.writeFile(path.join(root, note.path), 'External public replacement');
    await expect(vault.writeNote(note.path, 'Synthetic recovery secret', note.version, sid)).rejects.toThrow('CONFLICT:');
    await reopen(); const status = await vault.unlockPrivateSession('synthetic password');
    const recovered = await vault.recoverPrivateDraft(id, status.sessionId!);
    expect(recovered.path).not.toBe(note.path); expect(recovered.encrypted).toBe(true); expect(recovered.content).toBe('Synthetic recovery secret');
    expect((await vault.listPrivateDrafts(status.sessionId!))).toEqual([]);
    expect(await fs.readFile(path.join(root, note.path), 'utf8')).toBe('External public replacement');
  });
  it('retains only encrypted memory on journal failure, allows retry and explicit discard', async () => {
    const { note, sid } = await privateNote();
    await fs.writeFile(path.join(root, '.black-cobble/drafts'), 'blocked');
    await expect(vault.savePrivateDraft(note.path, 'Synthetic failed draft', note.version, 1, sid)).rejects.toThrow();
    expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(true);
    await fs.writeFile(path.join(root, note.path), 'External replacement blocks the flush');
    await vault.lockPrivateSession();
    await fs.unlink(path.join(root, '.black-cobble/drafts'));
    expect(await vault.retryPersistPrivateDrafts()).toBe(true);
    const unlocked = await vault.unlockPrivateSession('synthetic password');
    expect((await vault.listPrivateDrafts(unlocked.sessionId!))).toHaveLength(1);
    await fs.rm(path.join(root, '.black-cobble/drafts'), { recursive: true }); await fs.writeFile(path.join(root, '.black-cobble/drafts'), 'blocked');
    await expect(vault.savePrivateDraft(note.path, 'New failed draft', note.version, 2, unlocked.sessionId!)).rejects.toThrow();
    vault.discardMemoryPrivateDrafts(); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(false);
  });
  it('revokes synchronously and rejects queued saves and late unlock completions', async () => {
    const { note, sid } = await privateNote();
    const pendingSave = vault.writeNote(note.path, 'Must not commit', note.version, sid);
    const locked = vault.lockPrivateSession(); expect(vault.getPrivateSession().unlocked).toBe(false);
    await expect(pendingSave).rejects.toThrow(); await locked;
    const pendingUnlock = vault.unlockPrivateSession('synthetic password');
    await new Promise(resolve => setTimeout(resolve, 20));
    await vault.lockPrivateSession(); await expect(pendingUnlock).rejects.toThrow();
    expect(vault.getPrivateSession().unlocked).toBe(false);
    await vault.unlockPrivateSession('synthetic password'); expect((await vault.readNote(note.path)).content).toBe(note.content);
  });
  it('rejects missing/modified metadata, malformed private notes and initialization over orphaned private files', async () => {
    const { note, sid } = await privateNote();
    await fs.writeFile(path.join(root, '.black-cobble/private.json'), '{}');
    await expect(vault.writeNote(note.path, 'no', note.version, sid)).rejects.toThrow(); expect(vault.getPrivateSession().unlocked).toBe(false);
    await fs.unlink(path.join(root, '.black-cobble/private.json')); await reopen();
    await expect(vault.setupPrivateSession('replacement')).rejects.toThrow('Restaura');
    await fs.writeFile(path.join(root, note.path), `${PRIVATE_HEADER}-damaged`);
    expect((await vault.listEntries())[0].encrypted).toBe(true); await expect(vault.readNote(note.path)).rejects.toThrow();
  });
  it('clears a matching journal only after ciphertext commits, keeps a newer snapshot', async () => {
    const { note, sid } = await privateNote();
    await vault.savePrivateDraft(note.path, 'snapshot one', note.version, 1, sid);
    await vault.savePrivateDraft(note.path, 'snapshot two', note.version, 2, sid);
    const saved = await vault.writeNote(note.path, 'snapshot one', note.version, sid);
    expect((await vault.listPrivateDrafts(sid))).toHaveLength(1);
    await vault.writeNote(note.path, 'snapshot two', saved.version, sid);
    expect(await vault.listPrivateDrafts(sid)).toEqual([]);
  });
  it('blocks setup for orphaned recovery files even with no note files', async () => {
    const { note, sid } = await privateNote(); await vault.savePrivateDraft(note.path, 'recovery', note.version, 1, sid);
    await fs.unlink(path.join(root, note.path)); await vault.lockPrivateSession(); await fs.unlink(path.join(root, '.black-cobble/private.json'));
    await reopen(); await expect(vault.setupPrivateSession('replacement')).rejects.toThrow('borradores');
  });
  it('preserves valid metadata around crash temp files and malformed journals', async () => {
    const { note } = await privateNote();
    await fs.mkdir(path.join(root, '.black-cobble/drafts'));
    await fs.writeFile(path.join(root, '.black-cobble/drafts/.private-12345678-1234-4123-8123-123456789abc.tmp'), 'interrupted encrypted bytes');
    await fs.writeFile(path.join(root, '.black-cobble/drafts/broken.json'), '{}');
    await reopen();
    expect(vault.getPrivateSession().configured).toBe(true); expect(vault.getPrivateSession().error).toContain('borrador');
    await vault.unlockPrivateSession('synthetic password'); expect((await vault.readNote(note.path)).content).toBe(note.content);
    expect(await fs.readFile(path.join(root, '.black-cobble/drafts/broken.json'), 'utf8')).toBe('{}');
  });
  it('accepts fresh revision numbers after reopening while keeping prior recovery accessible', async () => {
    const { note, sid } = await privateNote();
    await vault.savePrivateDraft(note.path, 'old session recovery', note.version, 100, sid);
    await vault.writeNote(note.path, 'different committed content', note.version, sid);
    await reopen(); const unlocked = await vault.unlockPrivateSession('synthetic password'); const current = await vault.readNote(note.path);
    await vault.savePrivateDraft(note.path, 'new session recovery', current.version, 1, unlocked.sessionId!);
    const draft = (await vault.listPrivateDrafts(unlocked.sessionId!))[0];
    const recovered = await vault.recoverPrivateDraft(draft.id, unlocked.sessionId!); expect(recovered.content).toBe('new session recovery');
  });
  it('lists very large public files using only their marker prefix', async () => {
    const file = await fs.open(path.join(root, 'Grande.md'), 'wx');
    await file.truncate(40 * 1024 * 1024); await file.close();
    expect(await vault.listEntries()).toEqual([{ name: 'Grande.md', path: 'Grande.md', type: 'file' }]);
  });
  it('removes older durable journals when a newer memory draft successfully commits', async () => {
    const { note, sid } = await privateNote();
    await vault.savePrivateDraft(note.path, 'older recovery', note.version, 1, sid);
    const writer = vault as unknown as { persistDraft(): Promise<void> };
    const failure = vi.spyOn(writer, 'persistDraft').mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(vault.savePrivateDraft(note.path, 'latest recovery', note.version, 2, sid)).rejects.toThrow('disk failure');
    failure.mockRestore();
    await vault.writeNote(note.path, 'latest recovery', note.version, sid);
    await reopen(); expect(vault.getPrivateSession().recoveryCount).toBe(0);
  });
  it('explicitly discarding memory retains an older durable draft as a visible recovery', async () => {
    const { note, sid } = await privateNote();
    await vault.savePrivateDraft(note.path, 'durable recovery', note.version, 1, sid);
    const failure = vi.spyOn(vault as unknown as { persistDraft(): Promise<void> }, 'persistDraft').mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(vault.savePrivateDraft(note.path, 'memory recovery', note.version, 2, sid)).rejects.toThrow(); failure.mockRestore();
    vault.discardMemoryPrivateDrafts();
    expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(false); expect(vault.getPrivateSession().recoveryCount).toBe(1);
    const draft = (await vault.listPrivateDrafts(sid))[0];
    expect((await vault.recoverPrivateDraft(draft.id, sid)).content).toBe('durable recovery');
  });
  it('keeps a newer accepted encrypted snapshot when removing privacy commits an earlier draft', async () => {
    const { note, sid } = await privateNote();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = vault as unknown as { replaceNote(...args: unknown[]): Promise<void> };
    const original = writer.replaceNote.bind(vault);
    const delay = vi.spyOn(writer, 'replaceNote').mockImplementation(async (...args) => { entered(); await gate; await original(...args); });
    const conversion = vault.setNotePrivate(note.path, 'earlier public draft', note.version, false, sid);
    await started;
    const newerSnapshot = vault.savePrivateDraft(note.path, 'later encrypted recovery', note.version, 1, sid);
    release(); await conversion; await newerSnapshot; delay.mockRestore();
    const draft = (await vault.listPrivateDrafts(sid))[0];
    expect((await vault.recoverPrivateDraft(draft.id, sid)).content).toBe('later encrypted recovery');
    expect(await fs.readFile(path.join(root, note.path), 'utf8')).toBe('earlier public draft');
  });
  it('flushes accepted drafts as ciphertext during lock and shares its pending result across repeated locks', async () => {
    const { note, sid } = await privateNote();
    const snapshot = vault.savePrivateDraft(note.path, 'Immediate lock token synthetic', note.version, 1, sid);
    const first = vault.lockPrivateSession(); const repeated = vault.lockPrivateSession();
    expect(repeated).toBe(first); expect(vault.getPrivateSession().unlocked).toBe(false);
    await snapshot; await first;
    expect(vault.getPrivateSession().recoveryCount).toBe(0);
    const bytes = await fs.readFile(path.join(root, note.path), 'utf8');
    expect(bytes.startsWith(PRIVATE_HEADER)).toBe(true); expect(bytes).not.toContain('Immediate lock token');
    await vault.unlockPrivateSession('synthetic password'); expect((await vault.readNote(note.path)).content).toBe('Immediate lock token synthetic');
  });
});
