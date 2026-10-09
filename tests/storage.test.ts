import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultService } from '../electron/storage';

let temporary: string;
let root: string;
let vault: VaultService;
const services: VaultService[] = [];
let trashed: string[];

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'boveda-storage-'));
  root = path.join(temporary, 'vault');
  await fs.mkdir(root);
  trashed = [];
  vault = new VaultService(root, {
    watch: false,
    trash: async absolute => {
      trashed.push(absolute);
      await fs.rename(absolute, path.join(temporary, `trash-${trashed.length}`));
    },
  });
  services.push(vault);
  await vault.initialize();
});

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('VaultService', () => {
  it('creates nested folders and round-trips Markdown, Unicode and BOM', async () => {
    expect(vault.info.name).toBe('vault');
    const folder = await vault.createFolder('', 'Apuntes');
    const nested = await vault.createFolder(folder, 'Curso');
    const note = await vault.createNote(nested, 'Introducción');
    expect(note.path).toBe('Apuntes/Curso/Introducción.md');
    const saved = await vault.writeNote(note.path, '\ufeff# Año\n\nEspañol y 日本語 🙂\n', note.version);
    expect(await vault.readNote(note.path)).toEqual(saved);
    expect(await fs.readFile(path.join(root, 'Apuntes', 'Curso', 'Introducción.md'), 'utf8')).toBe(saved.content);
    expect(saved.version).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.version).not.toBe(note.version);
    expect((await fs.readdir(path.join(root, 'Apuntes', 'Curso')))).toEqual(['Introducción.md']);
  });

  it('lists folders first and ignores non-Markdown files, hidden metadata and symlinks', async () => {
    await vault.createNote('', 'Zeta');
    await vault.createFolder('', 'Alfa');
    await vault.createNote('Alfa', 'Nota.MD');
    await fs.writeFile(path.join(root, 'imagen.png'), 'not a note');
    await fs.mkdir(path.join(root, '.obsidian'));
    await fs.writeFile(path.join(root, '.oculta.md'), 'hidden');
    expect(await vault.listEntries()).toEqual([
      { name: 'Alfa', path: 'Alfa', type: 'folder', children: [{ name: 'Nota.MD', path: 'Alfa/Nota.MD', type: 'file' }] },
      { name: 'Zeta.md', path: 'Zeta.md', type: 'file' },
    ]);
  });

  it('rejects external edits and deletions without overwriting or recreating a note', async () => {
    const note = await vault.createNote('', 'Nota');
    await fs.writeFile(path.join(root, note.path), 'External edit');
    await expect(vault.writeNote(note.path, 'Local edit', note.version)).rejects.toThrow('CONFLICT:');
    expect(await fs.readFile(path.join(root, note.path), 'utf8')).toBe('External edit');
    const external = await vault.readNote(note.path);
    await fs.unlink(path.join(root, note.path));
    await expect(vault.writeNote(note.path, 'Local edit', external.version)).rejects.toThrow('CONFLICT:');
    await expect(fs.stat(path.join(root, note.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes simultaneous saves so a stale version never wins', async () => {
    const note = await vault.createNote('', 'Nota');
    const results = await Promise.allSettled([
      vault.writeNote(note.path, 'first', note.version),
      vault.writeNote(note.path, 'second', note.version),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect((await vault.readNote(note.path)).content).toBe('first');
  });

  it('renames and moves notes and folders with stable content versions', async () => {
    await vault.createFolder('', 'Origen');
    await vault.createFolder('', 'Destino');
    const note = await vault.createNote('Origen', 'Nota');
    const renamed = await vault.renameEntry(note.path, 'Otra');
    expect(renamed).toBe('Origen/Otra.md');
    const moved = await vault.moveEntry(renamed, 'Destino');
    expect(moved).toBe('Destino/Otra.md');
    expect((await vault.readNote(moved)).version).toBe(note.version);
    await vault.createFolder('Destino', 'Interior');
    await vault.renameEntry('Destino', 'Archivo');
    expect((await vault.readNote('Archivo/Otra.md')).version).toBe(note.version);
    await expect(vault.moveEntry('Archivo', 'Archivo/Interior')).rejects.toThrow('dentro de sí misma');
  });

  it('rejects collisions and never overwrites existing entries', async () => {
    await vault.createNote('', 'Uno');
    await vault.createNote('', 'Dos');
    await vault.createFolder('', 'Carpeta');
    await expect(vault.createNote('', 'Uno')).rejects.toThrow();
    await expect(vault.createFolder('', 'Carpeta')).rejects.toThrow();
    await expect(vault.renameEntry('Uno.md', 'Dos')).rejects.toThrow();
    await vault.createNote('Carpeta', 'Uno');
    await expect(vault.moveEntry('Uno.md', 'Carpeta')).rejects.toThrow();
    expect(await vault.listEntries()).toHaveLength(3);
  });

  it('sends a note or a populated folder to the injected trash service', async () => {
    await vault.createNote('', 'Nota');
    await vault.trashEntry('Nota.md');
    await vault.createFolder('', 'Carpeta');
    await vault.createNote('Carpeta', 'Interior');
    await vault.trashEntry('Carpeta');
    expect(trashed).toEqual([path.join(root, 'Nota.md'), path.join(root, 'Carpeta')]);
    expect(await vault.listEntries()).toEqual([]);
    expect(await fs.readFile(path.join(temporary, 'trash-2', 'Interior.md'), 'utf8')).toBe('');
  });

  it.each(['../escape.md', '/escape.md', 'C:/escape.md', 'folder/../../escape.md', 'folder\\escape.md', '', './note.md', 'folder//note.md', 'stream.md:payload', 'note\0.md'])('rejects unsafe path %j', async input => {
    await expect(vault.readNote(input)).rejects.toThrow();
    await expect(vault.trashEntry(input)).rejects.toThrow();
  });

  it.each(['../outside', '.hidden', 'CON', 'AUX.md', 'file:stream', 'folder/name', 'folder\\name', 'last.', ''])('rejects unsafe filename %j', async name => {
    await expect(vault.createNote('', name)).rejects.toThrow();
    await expect(vault.createFolder('', name)).rejects.toThrow();
  });

  it('rejects symlink traversal, including a link pointing back inside the vault', async () => {
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside content');
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await vault.createFolder('', 'Real');
    await vault.createNote('Real', 'Note');
    await fs.symlink(path.join(root, 'Real'), path.join(root, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(vault.readNote('link/secret.md')).rejects.toThrow('simbólicos');
    await expect(vault.createNote('link', 'New')).rejects.toThrow('simbólicos');
    await expect(vault.readNote('inside-link/Note.md')).rejects.toThrow('simbólicos');
    await expect(vault.trashEntry('link')).rejects.toThrow('simbólicos');
    expect((await vault.listEntries()).map(entry => entry.name)).toEqual(['Real']);
    expect(await fs.readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('outside content');
  });

  it('only edits UTF-8 Markdown files and rejects invalid Unicode writes', async () => {
    await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe]));
    await fs.writeFile(path.join(root, 'other.txt'), 'text');
    await expect(vault.readNote('bad.md')).rejects.toThrow('UTF-8');
    await expect(vault.readNote('other.txt')).rejects.toThrow('Markdown');
    await expect(vault.renameEntry('other.txt', 'converted')).rejects.toThrow('Markdown');
    await expect(vault.trashEntry('other.txt')).rejects.toThrow('Markdown');
    const note = await vault.createNote('', 'Good');
    await expect(vault.writeNote(note.path, '\ud800', note.version)).rejects.toThrow('caracteres');
    expect((await vault.readNote(note.path)).content).toBe('');
  });

  it('notifies after an external filesystem edit', async () => {
    let signal!: () => void;
    const changed = new Promise<void>(resolve => { signal = resolve; });
    const watched = new VaultService(root, { onChange: () => signal() });
    services.push(watched);
    await watched.initialize();
    await fs.writeFile(path.join(root, 'external.md'), '# External');
    await changed;
    expect((await watched.listEntries())[0].path).toBe('external.md');
  }, 10_000);

  it('moves and renames a watched populated folder and keeps watching nested files', async () => {
    await fs.mkdir(path.join(root, 'Destinos', 'Sub'), { recursive: true });
    await fs.mkdir(path.join(root, 'Archivo'));
    await fs.writeFile(path.join(root, 'Destinos', 'Sub', 'Nota.md'), 'Original');
    let notifications = 0;
    const watched = new VaultService(root, { onChange: () => { notifications++; } });
    services.push(watched);
    await watched.initialize();
    expect(await watched.moveEntry('Destinos', 'Archivo')).toBe('Archivo/Destinos');
    expect(await watched.renameEntry('Archivo/Destinos', 'Renombrado')).toBe('Archivo/Renombrado');
    const movedNote = path.join(root, 'Archivo', 'Renombrado', 'Sub', 'Nota.md');
    expect(await fs.readFile(movedNote, 'utf8')).toBe('Original');
    await expect(fs.stat(path.join(root, 'Destinos'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Let the explicit relocation notification settle, then require a new one.
    await new Promise(resolve => setTimeout(resolve, 200));
    const before = notifications;
    await fs.writeFile(movedNote, 'External edit after moving');
    await expect.poll(() => notifications).toBeGreaterThan(before);
    expect((await watched.readNote('Archivo/Renombrado/Sub/Nota.md')).content).toBe('External edit after moving');
  }, 10_000);

  it('releases watched folder handles for trash and restores watching after trash errors', async () => {
    await fs.mkdir(path.join(root, 'Folder', 'Nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'Folder', 'Nested', 'Note.md'), 'Original');
    let rejectTrash = true;
    let notifications = 0;
    const watched = new VaultService(root, {
      onChange: () => { notifications++; },
      trash: async absolute => {
        if (rejectTrash) throw new Error('Trash unavailable');
        await fs.rename(absolute, path.join(temporary, 'watched-trash'));
      },
    });
    services.push(watched);
    await watched.initialize();
    await expect(watched.trashEntry('Folder')).rejects.toThrow('Trash unavailable');
    await new Promise(resolve => setTimeout(resolve, 200));
    const before = notifications;
    await fs.writeFile(path.join(root, 'Folder', 'Nested', 'Note.md'), 'Edit after failed trash');
    await expect.poll(() => notifications).toBeGreaterThan(before);
    rejectTrash = false;
    await watched.trashEntry('Folder');
    expect(await fs.readFile(path.join(temporary, 'watched-trash', 'Nested', 'Note.md'), 'utf8')).toBe('Edit after failed trash');
    await new Promise(resolve => setTimeout(resolve, 200));
    const afterTrash = notifications;
    await fs.writeFile(path.join(root, 'after-trash.md'), 'Still watching');
    await expect.poll(() => notifications).toBeGreaterThan(afterTrash);
  }, 10_000);
});
