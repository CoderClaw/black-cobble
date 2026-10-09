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
});
