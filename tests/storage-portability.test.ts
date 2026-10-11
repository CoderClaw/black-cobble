import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultService } from '../electron/storage';

const posixOnly = it.skipIf(process.platform === 'win32');
let temporary: string;
let root: string;
let vault: VaultService;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'boveda-portability-'));
  root = path.join(temporary, 'vault');
  await fs.mkdir(root);
  vault = new VaultService(root, { watch: false });
  await vault.initialize();
});

afterEach(async () => {
  await vault.dispose();
  await fs.rm(temporary, { recursive: true, force: true });
});

/** Names legal on Linux that no vault path can express; they must be invisible, not fatal. */
async function plantForeignNames(): Promise<void> {
  await fs.writeFile(path.join(root, 'Re: factura.pdf'), 'pdf');
  await fs.mkdir(path.join(root, 'a:b'));
  await fs.writeFile(path.join(root, 'a:b', 'Dentro.md'), 'hidden with its folder');
  await fs.writeFile(path.join(root, 'a\\b.md'), 'backslash note');
}

describe('names that are not valid vault components', () => {
  posixOnly('listEntries skips them and still lists valid notes', async () => {
    await plantForeignNames();
    await fs.mkdir(path.join(root, 'Carpeta'));
    await fs.writeFile(path.join(root, 'Carpeta', 'Hija.md'), 'x');
    await fs.writeFile(path.join(root, 'Carpeta', 'Re: nota.md'), 'x');
    await fs.writeFile(path.join(root, 'Valida.md'), 'x');
    expect(await vault.listEntries()).toEqual([
      { name: 'Carpeta', path: 'Carpeta', type: 'folder', children: [{ name: 'Hija.md', path: 'Carpeta/Hija.md', type: 'file' }] },
      { name: 'Valida.md', path: 'Valida.md', type: 'file' },
    ]);
  });

  posixOnly('rename and move still work in a vault containing them', async () => {
    await plantForeignNames();
    await fs.mkdir(path.join(root, 'Destino'));
    await fs.writeFile(path.join(root, 'Destino', 'Re: x.md'), 'x');
    const note = await vault.createNote('', 'Nota');
    expect(await vault.renameEntry(note.path, 'Otra')).toBe('Otra.md');
    expect(await vault.moveEntry('Otra.md', 'Destino')).toBe('Destino/Otra.md');
    expect(await vault.renameEntry('Destino', 'Archivo')).toBe('Archivo');
    expect((await vault.readNote('Archivo/Otra.md')).version).toBe(note.version);
    expect((await fs.readdir(root)).sort()).toEqual(['Archivo', 'Re: factura.pdf', 'a:b', 'a\\b.md']);
  });

  posixOnly('private session setup works in a vault containing them', async () => {
    await plantForeignNames();
    const status = await vault.setupPrivateSession('synthetic password for tests');
    expect(status.configured).toBe(true);
    expect(status.unlocked).toBe(true);
  });

  it('relative() stays strict for IPC input', async () => {
    await expect(vault.readNote('Re: x.md')).rejects.toThrow('Ruta no válida.');
    await expect(vault.readNote('a\\b.md')).rejects.toThrow('Ruta no válida.');
  });
});

describe('case-insensitive collisions', () => {
  it('rejects creating a note whose name differs only by case', async () => {
    await fs.writeFile(path.join(root, 'Nota.md'), 'x');
    await expect(vault.createNote('', 'nota')).rejects.toThrow('Ya existe una nota o carpeta con ese nombre.');
    await expect(vault.createFolder('', 'NOTA.md')).rejects.toThrow('Ya existe una nota o carpeta con ese nombre.');
    expect(await fs.readdir(root)).toEqual(['Nota.md']);
  });

  it('rejects a counterpart note in another format, case-insensitively', async () => {
    await fs.writeFile(path.join(root, 'Nota.md'), 'x');
    await expect(vault.createNote('', 'nota', 'html')).rejects.toThrow('Ya existe una nota con ese nombre en otro formato.');
    await expect(vault.createNote('', 'Nota', 'html')).rejects.toThrow('Ya existe una nota con ese nombre en otro formato.');
    expect(await fs.readdir(root)).toEqual(['Nota.md']);
  });

  it('rejects creating a folder whose name differs only by case', async () => {
    await fs.mkdir(path.join(root, 'Notas'));
    await expect(vault.createFolder('', 'notas')).rejects.toThrow('Ya existe una nota o carpeta con ese nombre.');
    expect(await fs.readdir(root)).toEqual(['Notas']);
  });

  it('counts hidden entries as conflicts', async () => {
    await fs.mkdir(path.join(root, 'Archivos'));
    await fs.writeFile(path.join(root, 'Archivos', 'nota.md.bak'), 'x');
    await expect(vault.createFolder('Archivos', 'NOTA.md.BAK')).rejects.toThrow('Ya existe');
  });

  it('rejects renaming onto a case variant of another entry', async () => {
    await fs.writeFile(path.join(root, 'Uno.md'), 'x');
    await fs.writeFile(path.join(root, 'Dos.md'), 'x');
    await expect(vault.renameEntry('Uno.md', 'DOS')).rejects.toThrow('Ya existe');
    expect((await fs.readdir(root)).sort()).toEqual(['Dos.md', 'Uno.md']);
  });

  it('rejects moving a note into a folder holding a case-variant name', async () => {
    await fs.mkdir(path.join(root, 'Destino'));
    await fs.writeFile(path.join(root, 'Destino', 'nota.md'), 'dest');
    await fs.writeFile(path.join(root, 'Nota.md'), 'src');
    await expect(vault.moveEntry('Nota.md', 'Destino')).rejects.toThrow('Ya existe');
    expect(await fs.readFile(path.join(root, 'Destino', 'nota.md'), 'utf8')).toBe('dest');
    expect(await fs.readFile(path.join(root, 'Nota.md'), 'utf8')).toBe('src');
  });

  it('rejects moving a note into a folder holding its counterpart in a case variant', async () => {
    await fs.mkdir(path.join(root, 'Destino'));
    await fs.writeFile(path.join(root, 'Destino', 'nota.html'), 'dest');
    await fs.writeFile(path.join(root, 'Nota.md'), 'src');
    await expect(vault.moveEntry('Nota.md', 'Destino')).rejects.toThrow('otro formato');
  });

  it('rejects a private copy whose name collides case-insensitively', async () => {
    const { sessionId } = await vault.setupPrivateSession('synthetic password for tests');
    await fs.writeFile(path.join(root, 'Nota.md'), 'x');
    await expect(vault.createPrivateCopy('', 'nota', 'secret', sessionId!)).rejects.toThrow('Ya existe');
  });
});

describe('case-only renames', () => {
  it('renames Nota.md to nota.md and the new case shows on disk', async () => {
    await vault.createNote('', 'Nota');
    expect(await vault.renameEntry('Nota.md', 'nota')).toBe('nota.md');
    expect(await fs.readdir(root)).toEqual(['nota.md']);
    expect((await vault.listEntries()).map(entry => entry.name)).toEqual(['nota.md']);
  });

  it('renames a folder that only changes case', async () => {
    await vault.createFolder('', 'Carpeta');
    await vault.createNote('Carpeta', 'Interior');
    expect(await vault.renameEntry('Carpeta', 'carpeta')).toBe('carpeta');
    expect(await fs.readdir(root)).toEqual(['carpeta']);
    expect(await fs.readdir(path.join(root, 'carpeta'))).toEqual(['Interior.md']);
  });

  posixOnly('rejects a case-only rename that collides with another entry', async () => {
    await fs.writeFile(path.join(root, 'Nota.md'), 'upper');
    await fs.writeFile(path.join(root, 'nota.md'), 'lower');
    await expect(vault.renameEntry('Nota.md', 'NOTA')).rejects.toThrow('Ya existe');
    expect(await fs.readFile(path.join(root, 'Nota.md'), 'utf8')).toBe('upper');
    expect(await fs.readFile(path.join(root, 'nota.md'), 'utf8')).toBe('lower');
  });
});
