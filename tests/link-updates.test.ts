import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rewriteWikiLinks } from '../shared/linkUpdates';
import { resolveWikiLink } from '../src/editor/wikilinks';
import { VaultService } from '../electron/storage';

describe('rewriteWikiLinks', () => {
  it('keeps the escaped alias pipe of links inside Markdown tables (CR01)', () => {
    const paths = ['Tabla.md', 'Nota.md'];
    const moves = new Map([['Nota.md', 'Otra.md']]);
    expect(rewriteWikiLinks('| a | [[Nota\\|alias]] |\n| b | [[Nota#Parte\\|alias]] |', 'Tabla.md', 'Tabla.md', paths, moves))
      .toBe('| a | [[/Otra\\|alias]] |\n| b | [[/Otra#Parte\\|alias]] |');
    // Outside tables the backslash is kept as well: every byte but the path stays as written.
    expect(rewriteWikiLinks('[[Nota\\|alias]] [[Nota|alias]]', 'Tabla.md', 'Tabla.md', paths, moves)).toBe('[[/Otra\\|alias]] [[/Otra|alias]]');
  });
  it('keeps only the escape, not the old name\'s spaces, so the link reaches the moved note', () => {
    // "Nota .md" (trailing space) is reached by [[Nota \|alias]]; keeping that space would now reach "Otra .md".
    const paths = ['Tabla.md', 'Nota .md', 'Otra .md'];
    const rewritten = rewriteWikiLinks('[[Nota \\|alias]]', 'Tabla.md', 'Tabla.md', paths, new Map([['Nota .md', 'Otra.md']]));
    expect(rewritten).toBe('[[/Otra\\|alias]]');
    expect(resolveWikiLink(rewritten.slice(2, -2), 'Tabla.md', ['Tabla.md', 'Otra.md', 'Otra .md'])).toBe('Otra.md');
  });
  it('keeps an explicit .html through an escaped table pipe when both formats exist', () => {
    const paths = ['Tabla.md', 'Old/Nota.html', 'Old/Nota.md'];
    const moves = new Map([['Old/Nota.html', 'ZZ/Old/Nota.html'], ['Old/Nota.md', 'ZZ/Old/Nota.md']]);
    const rewritten = rewriteWikiLinks('| [[Old/Nota.html\\|HTML]] |', 'Tabla.md', 'Tabla.md', paths, moves);
    expect(rewritten).toBe('| [[ZZ/Old/Nota.html\\|HTML]] |');
    // Extra backslashes before the pipe are kept too, and do not hide the extension either.
    expect(rewriteWikiLinks('[[Old/Nota.html\\\\\\|HTML]]', 'Tabla.md', 'Tabla.md', paths, moves)).toBe('[[ZZ/Old/Nota.html\\\\\\|HTML]]');
  });
  it('adapts a copy moved to another folder, keeping links it cannot express as written', () => {
    const paths = ['Root.md', 'C#/Apuntes #1.md', 'C#/Otra.md'];
    // C#/Otra cannot be written as a path, but the bare name still reaches it; local headings never change.
    const copied = rewriteWikiLinks('[[../Root]] [[./Otra#Parte|alias]] [[Root]] [[#Local]]', 'C#/Apuntes #1.md', 'Apuntes 1 copia.md', paths, new Map(), { keepUnreachable: true });
    expect(copied).toBe('[[/Root]] [[Otra#Parte|alias]] [[Root]] [[#Local]]');
    // With another Otra winning the bare name there is no way to name it: kept as written, or refused by default.
    const ambiguous = [...paths, 'A/Otra.md'];
    expect(rewriteWikiLinks('[[./Otra]]', 'C#/Apuntes #1.md', 'Apuntes 1 copia.md', ambiguous, new Map(), { keepUnreachable: true })).toBe('[[./Otra]]');
    expect(() => rewriteWikiLinks('[[./Otra]]', 'C#/Apuntes #1.md', 'Apuntes 1 copia.md', ambiguous, new Map())).toThrow('# ^ [ ] |');
  });
  it('never keeps a link that would quietly reach another note', () => {
    // From the root, ./Otra reaches the root Otra.md: keeping it would redirect the link, so the copy is refused.
    const paths = ['C#/Source.md', 'C#/Otra.md', 'Otra.md'];
    expect(() => rewriteWikiLinks('[[./Otra#Parte|alias]]', 'C#/Source.md', 'Source copia.md', paths, new Map(), { keepUnreachable: true })).toThrow('# ^ [ ] |');
  });
  it('checks a bare-name fallback as written, escape and extension included', () => {
    // [[./Otra\|alias]] → renaming C#/Otra.md: "Renamed\" reads as a path and would reach the root Renamed.md.
    const paths = ['C#/Source.md', 'C#/Otra.md', 'Renamed.md'];
    const moves = new Map([['C#/Otra.md', 'C#/Renamed.md']]);
    expect(() => rewriteWikiLinks('| [[./Otra\\|alias]] |', 'C#/Source.md', 'C#/Source.md', paths, moves)).toThrow('# ^ [ ] |');
    // With an A/Otra.md winning the bare name, only "Otra.html" still reaches the HTML note.
    const html = ['C#/Apuntes.md', 'C#/Otra.html', 'A/Otra.md'];
    expect(rewriteWikiLinks('[[./Otra#Parte|alias]]', 'C#/Apuntes.md', 'Apuntes copia.md', html, new Map(), { keepUnreachable: true })).toBe('[[Otra.html#Parte|alias]]');
  });
  it('never rewrites heading-only links, which always mean the note they are in', () => {
    // The original folder is gone: [[#Parte]] must keep pointing at the copy itself, not at Old/Source.
    expect(rewriteWikiLinks('[[#Parte]] [[#Parte|aquí]]', 'Old/Source.md', 'Source copia.md', ['Old/Source.md'], new Map(), { keepUnreachable: true })).toBe('[[#Parte]] [[#Parte|aquí]]');
  });
  it('refuses a rewrite whose destination no link can name', () => {
    const paths = ['Index.md', 'Old/C#/Nota.md', 'Z/Nota.md'];
    const moves = new Map([['Old/C#/Nota.md', 'ZZ/Old/C#/Nota.md']]);
    expect(() => rewriteWikiLinks('[[Nota]]', 'Index.md', 'Index.md', paths, moves)).toThrow('# ^ [ ] |');
  });
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

  it('only rewrites links that pointed at the moved case variant', () => {
    const paths = ['Inicio.md', 'Nota.md', 'nota.md'];
    const content = '[[Nota]] [[nota]] [[Nota.md]] [[nota.md]]';
    const movedLower = rewriteWikiLinks(content, 'Inicio.md', 'Inicio.md', paths, new Map([['nota.md', 'Otra.md']]));
    expect(movedLower).toBe('[[Nota]] [[/Otra]] [[Nota.md]] [[/Otra.md]]');
    const movedUpper = rewriteWikiLinks(content, 'Inicio.md', 'Inicio.md', paths, new Map([['Nota.md', 'Otra.md']]));
    expect(movedUpper).toBe('[[/Otra]] [[nota]] [[/Otra.md]] [[nota.md]]');
    const after = paths.map(note => (note === 'nota.md' ? 'Otra.md' : note));
    expect(resolveWikiLink('Nota', 'Inicio.md', after)).toBe('Nota.md');
    expect(resolveWikiLink('/Otra', 'Inicio.md', after)).toBe('Otra.md');
  });

  it('keeps case-variant links pointing at their own note when notes or sources move', () => {
    const paths = ['Inicio.md', 'Nota.md', 'nota.md'];
    const moves = new Map([['Nota.md', 'Archivo/Nota.md']]);
    expect(rewriteWikiLinks('[[Nota]] [[nota]]', 'Inicio.md', 'Inicio.md', paths, moves)).toBe('[[Archivo/Nota]] [[nota]]');
    const sibling = ['Dir/Fuente.md', 'Dir/Nota.md', 'Dir/nota.md'];
    expect(rewriteWikiLinks('[[Nota]] [[nota]]', 'Dir/Fuente.md', 'Nuevo/Fuente.md', sibling, new Map([['Dir/Fuente.md', 'Nuevo/Fuente.md']])))
      .toBe('[[Nota]] [[nota]]');
    // A new sibling variant shadows only the bare link with that exact case; each link is pinned to its own note.
    const shadowed = ['Dir/Fuente.md', 'Dir/Nota.md', 'Dir/nota.md', 'Nuevo/nota.md'];
    expect(rewriteWikiLinks('[[Nota]] [[nota]]', 'Dir/Fuente.md', 'Nuevo/Fuente.md', shadowed, new Map([['Dir/Fuente.md', 'Nuevo/Fuente.md']])))
      .toBe('[[Dir/Nota]] [[Dir/nota]]');
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
