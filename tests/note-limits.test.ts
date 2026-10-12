import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_NOTE_BYTES } from '../shared/notes';
import { VaultService } from '../electron/storage';

describe('note size limit', () => {
  let temporary: string;
  let vault: VaultService;
  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'boveda-limit-'));
    vault = new VaultService(temporary, { watch: false, trash: async absolute => { await fs.rm(absolute); } });
    await vault.initialize();
  });
  afterEach(async () => { await vault.dispose(); await fs.rm(temporary, { recursive: true, force: true }); });

  it('accepts only saves that open again, and a rejected save keeps the previous file', async () => {
    const note = await vault.createNote('', 'Grande');
    let version = note.version;
    // ASCII, CJK and emoji take 1, 3 and 4 bytes per character in UTF-8.
    for (const unit of ['a', '漢', '🙂']) {
      const fits = unit.repeat(Math.floor(MAX_NOTE_BYTES / Buffer.byteLength(unit)));
      version = (await vault.writeNote(note.path, fits, version)).version;
      const read = await vault.readNote(note.path);
      expect([read.content.length, read.version]).toEqual([fits.length, version]);
      await expect(vault.writeNote(note.path, fits + unit, version)).rejects.toThrow('tamaño máximo');
      expect((await vault.readNote(note.path)).version).toBe(version);
    }
  }, 60_000);

  describe('renaming and moving rewrite links', () => {
    // `[[a]]` becomes `[[/aa]]` when a.md is renamed to aa.md: two more bytes.
    const link = '[[a]]\n';
    const files = async (...names: string[]) => Object.fromEntries(await Promise.all(names.map(async name => [name, (await fs.readFile(path.join(temporary, name))).toString('utf8')])));
    const filler = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)));

    it('renames when every rewritten note still fits exactly at the limit', async () => {
      for (const [unit, size] of [['a', MAX_NOTE_BYTES - 2], ['漢', MAX_NOTE_BYTES - 2], ['🙂', MAX_NOTE_BYTES - 2]] as const) {
        const body = filler(unit, size - link.length);
        const pad = 'a'.repeat(size - link.length - Buffer.byteLength(body));
        await fs.writeFile(path.join(temporary, 'a.md'), 'destino');
        await fs.writeFile(path.join(temporary, 'b.md'), link + body + pad);
        expect((await fs.stat(path.join(temporary, 'b.md'))).size).toBe(MAX_NOTE_BYTES - 2);
        await vault.renameEntry('a.md', 'aa');
        expect((await fs.stat(path.join(temporary, 'b.md'))).size).toBe(MAX_NOTE_BYTES);
        const read = await vault.readNote('b.md');
        expect(read.content.startsWith('[[/aa]]\n')).toBe(true);
        await vault.renameEntry('aa.md', 'a');
        await fs.rm(path.join(temporary, 'b.md'));
        await fs.rm(path.join(temporary, 'a.md'));
      }
    }, 60_000);

    it('rejects a rename that would leave a linking note over the limit and changes nothing on disk', async () => {
      for (const unit of ['a', '漢', '🙂']) {
        const body = filler(unit, MAX_NOTE_BYTES - 1 - link.length);
        const pad = 'a'.repeat(MAX_NOTE_BYTES - 1 - link.length - Buffer.byteLength(body));
        // c.md follows a smaller note that could be rewritten first.
        await fs.writeFile(path.join(temporary, 'a.md'), 'destino');
        await fs.writeFile(path.join(temporary, 'b.md'), '[[a]] pequeña');
        await fs.writeFile(path.join(temporary, 'c.md'), link + body + pad);
        expect((await fs.stat(path.join(temporary, 'c.md'))).size).toBe(MAX_NOTE_BYTES - 1);
        const before = await files('a.md', 'b.md', 'c.md');
        await expect(vault.renameEntry('a.md', 'aa')).rejects.toThrow('tamaño máximo');
        await expect(fs.stat(path.join(temporary, 'aa.md'))).rejects.toThrow();
        expect(await files('a.md', 'b.md', 'c.md')).toEqual(before);
        expect((await vault.readNote('c.md')).content.startsWith('[[a]]\n')).toBe(true);
        await Promise.all(['a.md', 'b.md', 'c.md'].map(name => fs.rm(path.join(temporary, name))));
      }
    }, 120_000);

    it('rejects a move into a folder that would push a linking note over the limit', async () => {
      await fs.mkdir(path.join(temporary, 'Dir'));
      await fs.writeFile(path.join(temporary, 'a.md'), 'destino');
      // Bare links keep resolving after a move, but `[[/a]]` becomes `[[Dir/a]]`: three more bytes.
      const absolute = '[[/a]]\n';
      await fs.writeFile(path.join(temporary, 'b.md'), absolute + 'a'.repeat(MAX_NOTE_BYTES - absolute.length));
      const before = await files('a.md', 'b.md');
      await expect(vault.moveEntry('a.md', 'Dir')).rejects.toThrow('tamaño máximo');
      expect(await files('a.md', 'b.md')).toEqual(before);
      await expect(fs.stat(path.join(temporary, 'Dir', 'a.md'))).rejects.toThrow();
      expect((await vault.readNote('b.md')).content.length).toBe(MAX_NOTE_BYTES);
      // Exactly at the limit after the rewrite: it moves and stays readable.
      await fs.writeFile(path.join(temporary, 'b.md'), absolute + 'a'.repeat(MAX_NOTE_BYTES - 3 - absolute.length));
      await vault.moveEntry('a.md', 'Dir');
      expect((await fs.stat(path.join(temporary, 'b.md'))).size).toBe(MAX_NOTE_BYTES);
      expect((await vault.readNote('b.md')).content.startsWith('[[Dir/a]]\n')).toBe(true);
    }, 60_000);
  });
});
