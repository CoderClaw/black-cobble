import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rewriteWikiLinks } from '../shared/linkUpdates';
import { resolveWikiLink } from '../src/editor/wikilinks';
import { VaultService } from '../electron/storage';

describe('rewriteWikiLinks', () => {
  it('preserves aliases, headings, spacing, and explicit extension preference', () => {
    const paths = ['A.md', 'Old/Note.MD'];
    const moves = new Map([['Old/Note.MD', 'New/Changed.MD']]);
    expect(rewriteWikiLinks('[[ Old/Note.MD # Header | My label ]] [[Old/Note]]', 'A.md', 'A.md', paths, moves))
      .toBe('[[ New/Changed.MD # Header | My label ]] [[New/Changed]]');
  });

  it('repairs outgoing relative links and bare links shadowed by a new sibling', () => {
    const paths = ['Old/Source.md', 'Old/Target.md', 'New/Target.md', 'Root.md', 'New/Root.md'];
    const moves = new Map([['Old/Source.md', 'New/Source.md']]);
    const content = '[[./Target#Part|target]] [[Root]] [[Missing]] [[#Here]]';
    expect(rewriteWikiLinks(content, 'Old/Source.md', 'New/Source.md', paths, moves))
      .toBe('[[Old/Target#Part|target]] [[/Root]] [[Missing]] [[#Here]]');
  });

  it('keeps short links when their intended destination still resolves', () => {
    const paths = ['A/Source.md', 'A/Target.md', 'B/Target.md'];
    const moves = new Map([['A/Source.md', 'C/Source.md'], ['A/Target.md', 'C/Target.md']]);
    expect(rewriteWikiLinks('[[Target]] [[./Target]] [[B/Target]]', 'A/Source.md', 'C/Source.md', paths, moves))
      .toBe('[[Target]] [[./Target]] [[B/Target]]');
  });

  it('protects an unmoved link from a moved note that wins basename resolution', () => {
    const paths = ['Source.md', 'B/Target.md', 'Z/Target.md'];
    const moves = new Map([['Z/Target.md', 'A/Target.md']]);
    const rewritten = rewriteWikiLinks('[[Target]]', 'Source.md', 'Source.md', paths, moves);
    expect(rewritten).toBe('[[B/Target]]');
    expect(resolveWikiLink(rewritten, 'Source.md', paths.map(note => moves.get(note) ?? note))).toBe('B/Target.md');
  });

  it('ignores fenced, indented, inline, nested code and escaped links', () => {
    const content = [
      '[[Old]]',
      '`[[Old]]` and ``a ` [[Old]]``',
      '\\[[Old]] and \\\\[[Old]]',
      '', '    [[Old]]', '',
      '~~~md', '[[Old]]', '~~~', '',
      '> ```', '> [[Old]]', '> ```',
    ].join('\n');
    const result = rewriteWikiLinks(content, 'Source.md', 'Source.md', ['Source.md', 'Old.md'], new Map([['Old.md', 'New.md']]));
    expect(result).toBe(content.replace(/^\[\[Old\]\]/, '[[/New]]').replace('and \\\\[[Old]]', 'and \\\\[[/New]]'));
  });
});

const temporary: string[] = [];
const services: VaultService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const folder of temporary.splice(0)) await fs.rm(folder, { recursive: true, force: true });
});

async function setup(files: Record<string, string>): Promise<{ vault: VaultService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'black-cobble-links-'));
  temporary.push(root);
  for (const [note, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, note)), { recursive: true });
    await fs.writeFile(path.join(root, note), content);
  }
  const vault = new VaultService(root, { watch: false });
  services.push(vault);
  await vault.initialize();
  return { vault, root };
}

describe('VaultService link preservation', () => {
  it('preserves links in legacy encrypted notes and requires unlocking before relocation', async () => {
    const { vault, root } = await setup({ 'Target.md': '', 'Secret.md': '[[Target]]' });
    const session = await vault.setupPrivateSession('correct horse battery staple');
    const secret = await vault.readNote('Secret.md');
    await vault.setNotePrivate(secret.path, secret.content, secret.version, true, session.sessionId!);
    await vault.renameEntry('Target.md', 'Renamed');
    expect((await vault.readNote('Secret.md')).content).toBe('[[/Renamed]]');
    expect(await fs.readFile(path.join(root, 'Secret.md'), 'utf8')).not.toContain('Renamed');
    await vault.lockPrivateSession();
    await expect(vault.renameEntry('Renamed.md', 'Other')).rejects.toThrow('Desbloquea');
    expect(await fs.readFile(path.join(root, 'Renamed.md'), 'utf8')).toBe('');
  });

  it('updates inbound and outgoing links for every descendant of a moved folder', async () => {
    const { vault, root } = await setup({
      'Old/Source.md': '[[./Nested/Target]] [[../Root#Header|Root]]',
      'Old/Nested/Target.md': '[[../Source]]',
      'Root.md': '[[Old/Source.md]] [[Old/Nested/Target]]',
      '.private-vault/Secret.md': '[[Old/Source]]',
    });
    await vault.createFolder('', 'Archive');
    expect(await vault.moveEntry('Old', 'Archive')).toBe('Archive/Old');
    expect((await vault.readNote('Root.md')).content).toBe('[[Archive/Old/Source.md]] [[Archive/Old/Nested/Target]]');
    expect((await vault.readNote('Archive/Old/Source.md')).content).toBe('[[./Nested/Target]] [[/Root#Header|Root]]');
    expect((await vault.readNote('Archive/Old/Nested/Target.md')).content).toBe('[[../Source]]');
    expect(await fs.readFile(path.join(root, '.private-vault/Secret.md'), 'utf8')).toBe('[[Old/Source]]');
  });

  it('does not change bytes or versions when existing links still resolve', async () => {
    const { vault } = await setup({ 'Old/Source.md': '\ufeff[[./Target]]\r\n', 'Old/Target.md': 'same' });
    const before = await vault.readNote('Old/Source.md');
    await vault.renameEntry('Old', 'New');
    expect((await vault.readNote('New/Source.md')).version).toBe(before.version);
  });

  it('rolls back both the move and completed rewrites if a later write fails', async () => {
    const { vault, root } = await setup({ 'Target.md': '', 'A.md': '[[Target]]', 'B.md': '[[Target]]' });
    const internal = vault as unknown as { replaceNote: (...args: unknown[]) => Promise<void> };
    const original = internal.replaceNote.bind(vault);
    let writes = 0;
    vi.spyOn(internal, 'replaceNote').mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error('Disk write failed');
      return original(...args);
    });
    await expect(vault.renameEntry('Target.md', 'Renamed')).rejects.toThrow('Disk write failed');
    expect(await fs.readFile(path.join(root, 'A.md'), 'utf8')).toBe('[[Target]]');
    expect(await fs.readFile(path.join(root, 'B.md'), 'utf8')).toBe('[[Target]]');
    expect(await fs.readFile(path.join(root, 'Target.md'), 'utf8')).toBe('');
    await expect(fs.stat(path.join(root, 'Renamed.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).sort()).toEqual(['A.md', 'B.md', 'Target.md']);
  });

  it('detects edits after preparation and aborts before moving', async () => {
    const { vault, root } = await setup({ 'Target.md': '', 'A.md': '[[Target]]' });
    const internal = vault as unknown as { raw: (...args: unknown[]) => Promise<unknown> };
    const original = internal.raw.bind(vault);
    let reads = 0;
    vi.spyOn(internal, 'raw').mockImplementation(async (...args) => {
      // Two initial snapshots, then a second read just before the filesystem move.
      if (++reads === 3) await fs.writeFile(path.join(root, 'A.md'), 'External edit');
      return original(...args);
    });
    await expect(vault.renameEntry('Target.md', 'Renamed')).rejects.toThrow('CONFLICT:');
    expect(await fs.readFile(path.join(root, 'A.md'), 'utf8')).toBe('External edit');
    expect(await fs.readFile(path.join(root, 'Target.md'), 'utf8')).toBe('');
    await expect(fs.stat(path.join(root, 'Renamed.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an external edit made during rewriting while rolling back other writes', async () => {
    const { vault, root } = await setup({ 'Target.md': '', 'A.md': '[[Target]]', 'B.md': '[[Target]]' });
    const internal = vault as unknown as { replaceNote: (...args: unknown[]) => Promise<void> };
    const original = internal.replaceNote.bind(vault);
    let writes = 0;
    vi.spyOn(internal, 'replaceNote').mockImplementation(async (...args) => {
      if (++writes === 2) await fs.writeFile(path.join(root, 'B.md'), 'External edit');
      return original(...args);
    });
    await expect(vault.renameEntry('Target.md', 'Renamed')).rejects.toThrow('CONFLICT:');
    expect(await fs.readFile(path.join(root, 'A.md'), 'utf8')).toBe('[[Target]]');
    expect(await fs.readFile(path.join(root, 'B.md'), 'utf8')).toBe('External edit');
    expect(await fs.readFile(path.join(root, 'Target.md'), 'utf8')).toBe('');
  });

  it('retains an external edit and reports a partial move if rollback would overwrite it', async () => {
    const { vault, root } = await setup({ 'Target.md': '', 'A.md': '[[Target]]', 'B.md': '[[Target]]' });
    const internal = vault as unknown as { replaceNote: (...args: unknown[]) => Promise<void> };
    const original = internal.replaceNote.bind(vault);
    let writes = 0;
    vi.spyOn(internal, 'replaceNote').mockImplementation(async (...args) => {
      if (++writes === 2) {
        await fs.writeFile(path.join(root, 'A.md'), 'External edit');
        throw new Error('Disk write failed');
      }
      return original(...args);
    });
    await expect(vault.renameEntry('Target.md', 'Renamed')).rejects.toThrow('Renamed.md quedó incompleto');
    expect(await fs.readFile(path.join(root, 'A.md'), 'utf8')).toBe('External edit');
    expect(await fs.readFile(path.join(root, 'Renamed.md'), 'utf8')).toBe('');
  });
});
