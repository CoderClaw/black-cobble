import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultWorkspace } from '../electron/vault-workspace';
import { EncryptedVault, PRIVATE_CHILD } from '../electron/encrypted-vault';
import { VaultService } from '../electron/storage';

let root: string;
let vault: VaultWorkspace;
const services: { dispose(): Promise<void> }[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'whole-private-')); vault = new VaultWorkspace(root, { watch: false }); services.push(vault); await vault.initialize(); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.dispose())); await fs.rm(root, { recursive: true, force: true }); });
const password = 'synthetic whole vault password';
async function open() { const status = await vault.setupPrivateSession(password); await vault.selectMode('private'); return status.sessionId!; }
async function relaunch() { await vault.dispose(); vault = new VaultWorkspace(root, { watch: false }); services.push(vault); await vault.initialize(); await vault.selectMode('private'); }
async function reopen(secret = password) { await relaunch(); return (await vault.unlockPrivateSession(secret)).sessionId!; }
async function allDisk(folder = root): Promise<string> { let result = ''; for (const entry of await fs.readdir(folder, { withFileTypes: true })) { result += entry.name; const file = path.join(folder, entry.name); result += entry.isDirectory() ? await allDisk(file) : await fs.readFile(file, 'utf8'); } return result; }
function backend(): EncryptedVault { return (vault as unknown as { privateVault: EncryptedVault }).privateVault; }

describe('whole private vault', () => {
  it.skipIf(process.platform !== 'win32')('retries transient Windows atomic rename sharing failures', async () => {
    const id = await open(); const note = await vault.createNote('', 'Transient');
    const writer = backend() as unknown as { renameFile(temp: string): Promise<void> }; const original = writer.renameFile.bind(backend());
    const sharing = Object.assign(new Error('Synthetic sharing violation'), { code: 'EPERM' });
    const rename = vi.spyOn(writer, 'renameFile').mockRejectedValueOnce(sharing).mockRejectedValueOnce(Object.assign(new Error('Synthetic busy target'), { code: 'EBUSY' })).mockImplementation(original);
    const saved = await vault.writeNote(note.path, 'Saved after bounded retry', note.version, id); expect(rename).toHaveBeenCalledTimes(3); rename.mockRestore();
    expect(saved.content).toBe('Saved after bounded retry'); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(false); await reopen(); expect((await vault.readNote(note.path)).content).toBe(saved.content);
  });
  it.skipIf(process.platform !== 'win32')('keeps sealed pending data after rename retry exhaustion', async () => {
    const id = await open(); const note = await vault.createNote('', 'Busy');
    const rename = vi.spyOn(backend() as unknown as { renameFile(temp: string): Promise<void> }, 'renameFile').mockRejectedValue(Object.assign(new Error('Synthetic persistent sharing violation'), { code: 'EPERM' }));
    await expect(vault.writeNote(note.path, 'Pending secret after sharing failures', note.version, id)).rejects.toThrow('sharing violation'); expect(rename).toHaveBeenCalledTimes(5); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(true); expect(await allDisk()).not.toContain('Pending secret'); rename.mockRestore();
    expect(await vault.retryPersistPrivateDrafts()).toBe(true); await reopen(); expect((await vault.readNote(note.path)).content).toBe('Pending secret after sharing failures');
  });
  it.skipIf(process.platform !== 'win32')('checks for external replacement before retrying a Windows rename', async () => {
    const id = await open(); const note = await vault.createNote('', 'Concurrent replacement'); const external = Buffer.from('Synthetic external replacement');
    const writer = backend() as unknown as { renameFile(temp: string): Promise<void> };
    const rename = vi.spyOn(writer, 'renameFile').mockImplementationOnce(async () => { await fs.writeFile(backend().file, external); throw Object.assign(new Error('Synthetic sharing violation'), { code: 'EPERM' }); });
    await expect(vault.writeNote(note.path, 'Retained encrypted pending changes', note.version, id)).rejects.toThrow('CONFLICT'); expect(rename).toHaveBeenCalledTimes(1); expect(vault.getPrivateSession().unlocked).toBe(false); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(true); expect(await fs.readFile(backend().file)).toEqual(external); rename.mockRestore();
    expect(await vault.retryPersistPrivateDrafts()).toBe(true); expect((await fs.readdir(path.join(root, PRIVATE_CHILD))).some(filename => filename.startsWith('recovery-'))).toBe(true);
  });
  it('keeps titles, folders, content and recovery paths encrypted through restart', async () => {
    const id = await open(); await vault.createFolder('', 'Synthetic confidential folder');
    const note = await vault.createNote('Synthetic confidential folder', 'Synthetic confidential title');
    await vault.writeNote(note.path, 'Synthetic confidential body', note.version, id);
    const current = await vault.readNote(note.path);
    await vault.savePrivateDraft(note.path, 'Synthetic confidential recovery', current.version, 1, id);
    const disk = await allDisk();
    for (const secret of ['Synthetic confidential folder', 'Synthetic confidential title', 'Synthetic confidential body', 'Synthetic confidential recovery']) expect(disk).not.toContain(secret);
    expect(await fs.readdir(path.join(root, PRIVATE_CHILD))).toEqual(['vault.sealed']);
    await reopen(); expect((await vault.readNote(note.path)).content).toBe('Synthetic confidential recovery');
  });
  it('shows an empty locked tree and revokes queued saves synchronously', async () => {
    const id = await open(); const note = await vault.createNote('', 'Secret');
    const write = vault.writeNote(note.path, 'Queued secret', note.version, id); const lock = vault.lockPrivateSession();
    expect(vault.getPrivateSession().unlocked).toBe(false); expect(await vault.listEntries()).toEqual([]);
    await expect(write).rejects.toThrow('bloqueada'); await lock;
    await expect(vault.readNote(note.path)).rejects.toThrow('bloqueada');
    await vault.unlockPrivateSession(password); expect((await vault.readNote(note.path)).content).toBe('');
  });
  it('seals an immediately accepted draft before lock and commits it encrypted', async () => {
    const id = await open(); const note = await vault.createNote('', 'Synthetic draft title');
    const save = vault.savePrivateDraft(note.path, 'Synthetic immediate draft', note.version, 1, id); const lock = vault.lockPrivateSession();
    await save; await lock; expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(false);
    expect(await allDisk()).not.toContain('Synthetic immediate draft'); await reopen(); expect((await vault.readNote(note.path)).content).toBe('Synthetic immediate draft');
  });
  it('keeps queued mutations newer than a synchronously admitted draft', async () => {
    const id = await open(); const note = await vault.createNote('', 'Original');
    const rename = vault.renameEntry(note.path, 'Renamed');
    const draft = vault.savePrivateDraft(note.path, 'Accepted during queued move', note.version, 1, id);
    await rename; await draft; await reopen(); expect((await vault.readNote('Renamed.md')).content).toBe('Accepted during queued move');
    await expect(vault.readNote('Original.md')).rejects.toThrow('CONFLICT');
  });
  it('does not regress password metadata when a draft follows queued password change', async () => {
    const id = await open(); const note = await vault.createNote('', 'Private');
    const change = vault.changePrivatePassword(password, 'new synthetic password', id);
    const draft = vault.savePrivateDraft(note.path, 'Password race draft', note.version, 1, id);
    await change; await draft; await vault.lockPrivateSession();
    await expect(vault.unlockPrivateSession(password)).rejects.toThrow();
    await vault.unlockPrivateSession('new synthetic password'); expect((await vault.readNote(note.path)).content).toBe('Password race draft');
  });
  it('keeps overlapping writes and drafts while a sealed commit is suspended', async () => {
    const id = await open(); const note = await vault.createNote('', 'Overlap');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = backend() as unknown as { persist(...args: unknown[]): Promise<void> }; const original = writer.persist.bind(backend());
    const delay = vi.spyOn(writer, 'persist').mockImplementationOnce(async (...args) => { entered(); await gate; await original(...args); });
    const write = vault.writeNote(note.path, 'first write', note.version, id); await started;
    const draft = vault.savePrivateDraft(note.path, 'latest recovery', note.version, 1, id);
    release(); await write; await draft; delay.mockRestore();
    const unlocked = await reopen(); expect((await vault.readNote(note.path)).content).toBe('first write');
    const recovery = await vault.listPrivateDrafts(unlocked); expect(recovery).toHaveLength(1); expect((await vault.recoverPrivateDraft(recovery[0].id, unlocked)).content).toBe('latest recovery');
  });
  it('seals drafts arriving during password commit with the new wrapped key', async () => {
    const id = await open(); const note = await vault.createNote('', 'Password overlap');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = backend() as unknown as { persist(...args: unknown[]): Promise<void> }; const original = writer.persist.bind(backend());
    const delay = vi.spyOn(writer, 'persist').mockImplementationOnce(async (...args) => { entered(); await gate; await original(...args); });
    const change = vault.changePrivatePassword(password, 'new password during disk write', id); await started;
    const draft = vault.savePrivateDraft(note.path, 'accepted after new password seal', note.version, 1, id);
    release(); await change; await draft; delay.mockRestore(); await vault.lockPrivateSession();
    await expect(vault.unlockPrivateSession(password)).rejects.toThrow(); await vault.unlockPrivateSession('new password during disk write'); expect((await vault.readNote(note.path)).content).toBe('accepted after new password seal');
  });
  it('rejects encrypted recovery belonging to another vault even with the same password', async () => {
    await open(); const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'other-whole-private-')); const other = new EncryptedVault(otherRoot, { watch: false });
    try { await other.initialize(); await other.setupPrivateSession(password); await other.createNote('', 'Foreign'); await fs.copyFile(other.file, path.join(root, PRIVATE_CHILD, 'recovery-12345678.sealed')); await vault.dispose(); vault = new VaultWorkspace(root, { watch: false }); services.push(vault); await vault.initialize(); await vault.selectMode('private'); await expect(vault.unlockPrivateSession(password)).rejects.toThrow('otra bóveda'); expect(vault.getPrivateSession().unlocked).toBe(false); }
    finally { await other.dispose(); await fs.rm(otherRoot, { recursive: true, force: true }); }
  });
  it('rejects an oversized snapshot without changing the saved note', async () => {
    const id = await open(); const note = await vault.createNote('', 'Size cap');
    await expect(vault.writeNote(note.path, 'x'.repeat(16 * 1024 * 1024), note.version, id)).rejects.toThrow('16 MiB');
    expect((await vault.readNote(note.path)).content).toBe(''); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(false);
  });
  it('deletes private notes and their drafts from the encrypted snapshot', async () => {
    const id = await open(); const note = await vault.createNote('', 'Deleted confidential title'); const saved = await vault.writeNote(note.path, 'Deleted confidential content', note.version, id);
    await vault.savePrivateDraft(saved.path, 'Deleted recovery draft', saved.version, 1, id);
    await vault.trashEntry(saved.path); expect(await vault.listEntries()).toEqual([]); expect(await allDisk()).not.toContain('Deleted confidential');
    expect(await vault.listPrivateDrafts(id)).toEqual([]); await reopen(); expect(await vault.listEntries()).toEqual([]);
  });
  it('updates private links and valid pending draft versions on folder moves', async () => {
    const id = await open(); await vault.createFolder('', 'Folder'); await vault.createFolder('', 'Destination');
    const target = await vault.createNote('Folder', 'Target'); const source = await vault.createNote('', 'Source');
    const linked = await vault.writeNote(source.path, '[[Folder/Target#Part|alias]]', source.version, id);
    await vault.savePrivateDraft(source.path, 'draft [[Folder/Target#Part|alias]]', linked.version, 1, id);
    await vault.moveEntry('Folder', 'Destination'); await vault.lockPrivateSession();
    await vault.unlockPrivateSession(password); const content = (await vault.readNote(source.path)).content;
    expect(content).toContain('draft [['); expect(content).toContain('Destination/Folder/Target#Part|alias');
    expect((await vault.readNote(`Destination/${target.path}`)).content).toBe(''); expect(await allDisk()).not.toContain('Destination');
  });
  it('preserves only sealed memory on disk failure and permits locked retry', async () => {
    const id = await open(); const note = await vault.createNote('', 'Private');
    const failure = vi.spyOn(backend() as unknown as { persist(...args: unknown[]): Promise<void> }, 'persist').mockRejectedValue(new Error('Synthetic disk failure'));
    await expect(vault.savePrivateDraft(note.path, 'Memory secret', note.version, 1, id)).rejects.toThrow('disk failure');
    await vault.lockPrivateSession(); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(true); expect(vault.getPrivateSession().unlocked).toBe(false);
    failure.mockRestore(); expect(await vault.retryPersistPrivateDrafts()).toBe(true);
    await vault.unlockPrivateSession(password); expect((await vault.readNote(note.path)).content).toBe('Memory secret');
  });
  it('keeps an encrypted recovery sidecar when another writer changes the snapshot', async () => {
    const id = await open(); const note = await vault.createNote('', 'Conflict'); const saved = await fs.readFile(backend().file);
    // A second valid snapshot has identical logical data but a different envelope.
    const other = new EncryptedVault(root, { watch: false }); services.push(other); await other.initialize(); await other.unlockPrivateSession(password); await other.createFolder('', 'External');
    await expect(vault.savePrivateDraft(note.path, 'Conflict private content', note.version, 1, id)).rejects.toThrow('CONFLICT');
    expect(vault.getPrivateSession().unlocked).toBe(false); expect(vault.getPrivateSession().memoryOnlyDrafts).toBe(true);
    expect(await vault.retryPersistPrivateDrafts()).toBe(true);
    expect((await fs.readdir(path.join(root, PRIVATE_CHILD))).some(file => file.startsWith('recovery-'))).toBe(true);
    expect(await allDisk()).not.toContain('Conflict private content'); expect(await fs.readFile(backend().file)).not.toEqual(saved);
    await other.dispose(); const reopenedId = await reopen(); const drafts = await vault.listPrivateDrafts(reopenedId);
    expect(drafts).toHaveLength(1); expect((await vault.recoverPrivateDraft(drafts[0].id, reopenedId)).content).toBe('Conflict private content');
  });
  it('unlocks when recovered versions do not fit and keeps them sealed until they do', async () => {
    const MiB = 1024 * 1024;
    const id = await open(); let note = await vault.createNote('', 'Grande');
    note = await vault.writeNote(note.path, 'a'.repeat(9 * MiB), note.version, id);
    // Another writer replaces the same note with a different 9 MiB version.
    const other = new EncryptedVault(root, { watch: false }); services.push(other); await other.initialize(); const otherStatus = await other.unlockPrivateSession(password);
    await other.writeNote(note.path, 'b'.repeat(9 * MiB), (await other.readNote(note.path)).version, otherStatus.sessionId!); await other.dispose();
    await expect(vault.savePrivateDraft(note.path, 'borrador', note.version, 1, id)).rejects.toThrow('CONFLICT');
    expect(await vault.retryPersistPrivateDrafts()).toBe(true);
    const recoveryFiles = async () => (await fs.readdir(path.join(root, PRIVATE_CHILD))).filter(file => file.startsWith('recovery-'));
    expect(await recoveryFiles()).toHaveLength(1);

    // Both 9 MiB versions exceed 16 MiB together: unlock still works and the large version stays on disk.
    let reopenedId = await reopen();
    expect(vault.getPrivateSession()).toMatchObject({ unlocked: true, recoveryPending: 1 });
    expect(await recoveryFiles()).toHaveLength(1);
    expect((await vault.readNote(note.path)).content).toBe('b'.repeat(9 * MiB));
    expect((await vault.listPrivateDrafts(reopenedId)).length).toBe(1);

    // Changing the password must not strand the pending file, which is still wrapped with the old one (GS01).
    const changed = 'synthetic password after pending recovery';
    await vault.changePrivatePassword(password, changed, reopenedId); await vault.lockPrivateSession();
    await expect(vault.unlockPrivateSession(password)).rejects.toThrow('Contraseña incorrecta');
    reopenedId = await reopen(changed);
    expect(vault.getPrivateSession()).toMatchObject({ unlocked: true, recoveryPending: 1 });
    expect(await recoveryFiles()).toHaveLength(1);

    // Once there is room, the next unlock incorporates the rest and only then deletes the file.
    const current = await vault.readNote(note.path); await vault.writeNote(note.path, 'pequeña', current.version, reopenedId);
    await vault.lockPrivateSession(); reopenedId = (await vault.unlockPrivateSession(changed)).sessionId!;
    expect(vault.getPrivateSession().recoveryPending).toBeUndefined();
    expect(await recoveryFiles()).toHaveLength(0);
    const drafts = await vault.listPrivateDrafts(reopenedId); expect(drafts).toHaveLength(2);
    const contents = await Promise.all(drafts.map(async draft => (await vault.recoverPrivateDraft(draft.id, reopenedId)).content.length));
    expect(contents.sort((x, y) => x - y)).toEqual(['borrador'.length, 9 * MiB]);
  }, 120_000);
  it('opens recovery sealed before a password change with the new password', async () => {
    const id = await open(); const note = await vault.createNote('', 'Antes del cambio');
    const before = await vault.writeNote(note.path, 'versión sellada con la contraseña anterior', note.version, id);
    const stale = await fs.readFile(backend().file);
    await vault.writeNote(note.path, 'versión actual', before.version, id);
    const changed = 'synthetic changed password';
    await vault.changePrivatePassword(password, changed, id);
    // A recovery copy left behind under the old wrapping, as a conflicting writer would leave it.
    await fs.writeFile(path.join(root, PRIVATE_CHILD, 'recovery-0a1b2c3d.sealed'), stale);
    await relaunch();
    await expect(vault.unlockPrivateSession(password)).rejects.toThrow('Contraseña incorrecta');
    const unlocked = await reopen(changed);
    expect(vault.getPrivateSession().recoveryPending).toBeUndefined();
    expect((await fs.readdir(path.join(root, PRIVATE_CHILD))).some(file => file.startsWith('recovery-'))).toBe(false);
    expect((await vault.readNote(note.path)).content).toBe('versión actual');
    const drafts = await vault.listPrivateDrafts(unlocked); expect(drafts).toHaveLength(1);
    expect((await vault.recoverPrivateDraft(drafts[0].id, unlocked)).content).toBe('versión sellada con la contraseña anterior');
  });
  it('names a damaged recovery file instead of reporting a wrong password', async () => {
    const id = await open(); const note = await vault.createNote('', 'Dañada');
    const before = await vault.writeNote(note.path, 'contenido sellado', note.version, id);
    const container = JSON.parse(await fs.readFile(backend().file, 'utf8')) as { envelope: string };
    await vault.writeNote(note.path, 'contenido actual', before.version, id);
    // Flip one ciphertext character: the envelope still parses, but authentication fails.
    const [header, body] = container.envelope.split('\n'); const envelope = JSON.parse(body) as { ciphertext: string };
    envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
    container.envelope = `${header}\n${JSON.stringify(envelope)}\n`;
    const tampered = path.join(root, PRIVATE_CHILD, 'recovery-deadbeef.sealed');
    await fs.writeFile(tampered, JSON.stringify(container));
    await relaunch();
    await expect(vault.unlockPrivateSession(password)).rejects.toThrow('recovery-deadbeef.sealed está dañado');
    expect(vault.getPrivateSession().unlocked).toBe(false);
    // A truncated or malformed file is named too, not reported as a generic error.
    await fs.writeFile(tampered, JSON.stringify(container).slice(0, 200));
    await expect(vault.unlockPrivateSession(password)).rejects.toThrow('recovery-deadbeef.sealed está dañado');
    // Setting it aside, as the message says, is enough to unlock in the same session.
    await fs.rename(tampered, path.join(root, 'recovery-deadbeef.sealed'));
    await vault.unlockPrivateSession(password);
    expect((await vault.readNote(note.path)).content).toBe('contenido actual');
  });
  it('rejects private names that wikilinks cannot reach (CR02)', async () => {
    await open(); await vault.createNote('', 'Nota');
    for (const name of ['C# básico', 'a^b', 'x[1]']) {
      await expect(vault.createNote('', name)).rejects.toThrow('rompen los enlaces');
      await expect(vault.createFolder('', name)).rejects.toThrow('rompen los enlaces');
      await expect(vault.renameEntry('Nota.md', name)).rejects.toThrow('rompen los enlaces');
    }
    expect((await vault.listEntries()).map(entry => entry.path)).toEqual(['Nota.md']);
  });
  it('rejects cross-vault paths and private tokens on normal writes', async () => {
    const publicNote = await vault.createNote('', 'Public'); const id = await open(); await vault.createNote('', 'Private');
    await vault.selectMode('normal'); expect(vault.getPrivateSession().unlocked).toBe(false);
    await expect(vault.writeNote(publicNote.path, 'must not become plaintext', publicNote.version, id)).rejects.toThrow('sesión');
    for (const attempt of [() => vault.moveEntry('Public.md', PRIVATE_CHILD), () => vault.trashEntry(PRIVATE_CHILD), () => vault.renameEntry(PRIVATE_CHILD, 'Visible'), () => vault.createNote(PRIVATE_CHILD, 'Plaintext'), () => vault.readNote(`${PRIVATE_CHILD}/vault.sealed`)]) expect(attempt).toThrow('internas');
    expect((await vault.listEntries()).map(entry => entry.path)).toEqual(['Public.md']); expect(await fs.readFile(path.join(root, 'Public.md'), 'utf8')).toBe('');
  });
  it('preserves legacy encrypted notes and blocks whole-vault configuration explicitly', async () => {
    const old = new VaultService(root, { watch: false }); services.push(old); await old.initialize(); const status = await old.setupPrivateSession('old password'); const note = await old.createNote('', 'Legacy');
    await old.setNotePrivate(note.path, 'Legacy body', note.version, true, status.sessionId!); await old.dispose();
    const bytes = await fs.readFile(path.join(root, note.path)); await vault.dispose(); vault = new VaultWorkspace(root, { watch: false }); services.push(vault); await vault.initialize();
    expect(vault.getPrivateSession().error).toContain('versión anterior'); await expect(vault.setupPrivateSession(password)).rejects.toThrow('versión anterior'); expect(await fs.readFile(path.join(root, note.path))).toEqual(bytes);
    const publicNote = await vault.createNote('', 'Public'); expect(publicNote.encrypted).toBeUndefined();
  });
  it('rejects late unlock completion after immediate revocation', async () => {
    await open(); await vault.lockPrivateSession(); const unlock = vault.unlockPrivateSession(password); await new Promise(resolve => setTimeout(resolve, 20)); await vault.lockPrivateSession(); await expect(unlock).rejects.toThrow('bloqueada'); expect(vault.getPrivateSession().unlocked).toBe(false);
  });
});
