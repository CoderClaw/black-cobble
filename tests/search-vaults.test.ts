import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultService } from '../electron/storage';
import { VaultWorkspace } from '../electron/vault-workspace';
import { EncryptedVault } from '../electron/encrypted-vault';
import { SearchRunner } from '../electron/search-runner';
import { searchFiles, type SearchOptions } from '../shared/search';

let root: string;
let workerFolder: string;
let workerFile: string;
let search: SearchRunner;
const services: { dispose(): Promise<void> }[] = [];
const options = (query: string, extra: Partial<SearchOptions> = {}): SearchOptions => ({ query, matchCase: false, wholeWord: false, regex: false, ...extra });
async function allDisk(folder = root): Promise<string> { let result = ''; for (const entry of await fs.readdir(folder, { withFileTypes: true })) { result += entry.name; const file = path.join(folder, entry.name); result += entry.isDirectory() ? await allDisk(file) : await fs.readFile(file, 'utf8'); } return result; }

// The app ships the worker as a bundle next to main.cjs; build the same entry once.
beforeAll(async () => {
  workerFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'black-cobble-worker-'));
  workerFile = path.join(workerFolder, 'search-worker.cjs');
  await build({ entryPoints: ['electron/search-worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: workerFile, logLevel: 'silent' });
});
afterAll(async () => { await fs.rm(workerFolder, { recursive: true, force: true }); });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'black-cobble-search-')); search = new SearchRunner(workerFile); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.dispose())); search.dispose(); await fs.rm(root, { recursive: true, force: true }); });

describe('normal vault search', () => {
  let vault: VaultService;
  let changes: number;
  beforeEach(async () => { changes = 0; vault = new VaultService(root, { watch: false, search, onChange: () => { changes++; } }); services.push(vault); await vault.initialize(); });

  it('searches notes in tree order with filters and skips unreadable files', async () => {
    await fs.mkdir(path.join(root, 'Proyectos', 'Sub'), { recursive: true });
    await fs.mkdir(path.join(root, '.oculto'));
    await fs.writeFile(path.join(root, 'zeta.md'), 'gato');
    await fs.writeFile(path.join(root, 'Proyectos', 'Sub', 'página.html'), '<html><head><title>gato</title></head><body><p>Un &amp; gato</p></body></html>');
    await fs.writeFile(path.join(root, 'Proyectos', 'nota.md'), 'Gato\ngato');
    await fs.writeFile(path.join(root, 'roto.md'), Buffer.from([0x67, 0x61, 0x74, 0x6f, 0xff]));
    await fs.writeFile(path.join(root, 'imagen.txt'), 'gato');
    await fs.writeFile(path.join(root, '.oculto', 'nota.md'), 'gato');
    await fs.symlink(path.join(root, 'zeta.md'), path.join(root, 'enlace.md')).catch(() => undefined);
    const result = await vault.searchNotes(options('gato'));
    expect(result.truncated).toBe(false);
    expect(result.files.map(file => [file.path, file.matches.length])).toEqual([['Proyectos/Sub/página.html', 1], ['Proyectos/nota.md', 2], ['zeta.md', 1]]);
    expect(result.files[1].matches[1]).toMatchObject({ start: 5, end: 9, line: 1 });
    expect(result.files[0].version).toBe((await vault.readNote('Proyectos/Sub/página.html')).version);
    expect((await vault.searchNotes(options('gato', { include: 'Proyectos', exclude: '*.html' }))).files.map(file => file.path)).toEqual(['Proyectos/nota.md']);
    expect((await vault.searchNotes(options('gato', { matchCase: true, include: 'Sub, zeta.md' }))).files.map(file => file.path)).toEqual(['Proyectos/Sub/página.html', 'zeta.md']);
    expect(await vault.searchNotes(options(''))).toEqual({ files: [], truncated: false });
    await expect(vault.searchNotes(options('[', { regex: true }))).rejects.toThrow('Expresión regular no válida');
  });

  it('replaces at the expected version, reports conflicts and writes atomically', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'uno gato, dos gato');
    await fs.writeFile(path.join(root, 'b.html'), '<p>gato &amp; gata</p>');
    await fs.writeFile(path.join(root, 'c.md'), 'gato');
    const found = await vault.searchNotes(options('gat(o|a)', { regex: true }));
    const [a, b, c] = found.files;
    await fs.writeFile(path.join(root, 'c.md'), 'gato externo');
    const outcomes = await vault.replaceInNotes(options('gat(o|a)', { regex: true }), '<perr$1>', [
      { path: a.path, version: a.version, matches: [a.matches[1]] },
      { path: b.path, version: b.version },
      { path: c.path, version: c.version },
      { path: 'falta.md', version: c.version },
      { path: '../fuera.md', version: c.version },
    ]);
    expect(outcomes.map(outcome => [outcome.path, outcome.status, outcome.count])).toEqual([
      ['a.md', 'replaced', 1], ['b.html', 'replaced', 2], ['c.md', 'conflict', 0], ['falta.md', 'conflict', 0], ['../fuera.md', 'error', 0],
    ]);
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('uno gato, dos <perro>');
    expect(await fs.readFile(path.join(root, 'b.html'), 'utf8')).toBe('<p>&lt;perro&gt; &amp; &lt;perra&gt;</p>');
    expect(await fs.readFile(path.join(root, 'c.md'), 'utf8')).toBe('gato externo');
    expect(outcomes[0].version).toBe((await vault.readNote('a.md')).version);
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(changes).toBe(1);
    const unchanged = await vault.replaceInNotes(options('ausente'), 'x', [{ path: 'a.md', version: outcomes[0].version! }]);
    expect(unchanged).toEqual([{ path: 'a.md', status: 'replaced', count: 0, version: outcomes[0].version, edits: [] }]);
    expect(outcomes[0].edits).toEqual([{ start: 14, end: 18, length: 7 }]);
    expect(outcomes[1].edits).toEqual([{ start: 3, end: 7, length: 13 }, { start: 14, end: 18, length: 13 }]);
  });

  it('never searches or rewrites legacy encrypted notes', async () => {
    const sid = (await vault.setupPrivateSession('synthetic password')).sessionId!;
    const original = await vault.createNote('', 'Privada');
    const note = await vault.setNotePrivate(original.path, 'Synthetic secret gato', original.version, true, sid);
    await fs.writeFile(path.join(root, 'publica.md'), 'gato');
    expect((await vault.searchNotes(options('gato'))).files.map(file => file.path)).toEqual(['publica.md']);
    const [outcome] = await vault.replaceInNotes(options('gato'), 'perro', [{ path: note.path, version: note.version }]);
    expect(outcome.status).toBe('error');
    expect(await fs.readFile(path.join(root, note.path), 'utf8')).not.toContain('perro');
  });

  it('skips notes above the size limit and rejects hidden paths', async () => {
    const { MAX_NOTE_BYTES } = await import('../shared/notes');
    await fs.writeFile(path.join(root, 'grande.md'), Buffer.alloc(MAX_NOTE_BYTES + 1, 'a'));
    await fs.writeFile(path.join(root, 'normal.md'), 'a');
    expect((await vault.searchNotes(options('a'))).files.map(file => file.path)).toEqual(['normal.md']);
    await fs.mkdir(path.join(root, '.black-cobble'));
    await fs.writeFile(path.join(root, '.black-cobble', 'x.md'), 'a');
    const hidden = (await vault.searchNotes(options('a'))).files[0].version;
    const [outcome] = await vault.replaceInNotes(options('a'), 'b', [{ path: '.black-cobble/x.md', version: hidden }]);
    expect(outcome.status).toBe('error');
  });
});

describe('private vault search', () => {
  let vault: VaultWorkspace;
  const password = 'synthetic search password';
  beforeEach(async () => { vault = new VaultWorkspace(root, { watch: false, search }); services.push(vault); await vault.initialize(); });
  async function open() { const status = await vault.setupPrivateSession(password); await vault.selectMode('private'); return status.sessionId!; }

  it('searches only the unlocked snapshot and never the normal files', async () => {
    await fs.writeFile(path.join(root, 'publica.md'), 'Synthetic gato público');
    expect((await vault.searchNotes(options('gato'))).files.map(file => file.path)).toEqual(['publica.md']);
    const id = await open();
    await expect(vault.searchNotes(options('gato'))).rejects.toThrow('bloqueada');
    await vault.createFolder('', 'Carpeta');
    const note = await vault.createNote('Carpeta', 'Secreta');
    const saved = await vault.writeNote(note.path, 'Synthetic gato privado', note.version, id);
    await vault.savePrivateDraft(note.path, 'Synthetic gato borrador gato', saved.version, 1, id);
    const result = await vault.searchNotes(options('gato'), id);
    expect(result.files).toEqual([{ path: 'Carpeta/Secreta.md', version: saved.version, matches: [expect.objectContaining({ start: 10, end: 14 })] }]);
    await vault.lockPrivateSession();
    await expect(vault.searchNotes(options('gato'), id)).rejects.toThrow('bloqueada');
    await vault.selectMode('normal');
    await expect(vault.searchNotes(options('gato'), id)).rejects.toThrow('privada');
  });

  it('rewrites every target in one sealed snapshot without plaintext on disk', async () => {
    const id = await open();
    const first = await vault.writeNote((await vault.createNote('', 'Uno')).path, 'Synthetic confidential gato', (await vault.readNote('Uno.md')).version, id);
    const html = await vault.createNote('', 'Dos', 'html');
    const second = await vault.writeNote(html.path, '<p>Synthetic confidential gato &amp; gato</p>', html.version, id);
    const third = await vault.writeNote((await vault.createNote('', 'Tres')).path, 'gato', (await vault.readNote('Tres.md')).version, id);
    await vault.writeNote(third.path, 'gato cambiado', third.version, id);
    const backend = (vault as unknown as { privateVault: EncryptedVault }).privateVault;
    const persist = vi.spyOn(backend as unknown as { persist(bytes: Buffer): Promise<void> }, 'persist');
    const outcomes = await vault.replaceInNotes(options('gato'), 'Synthetic replaced <perro>', [
      { path: first.path, version: first.version },
      { path: second.path, version: second.version },
      { path: third.path, version: third.version },
      { path: 'Falta.md', version: first.version },
    ], id);
    expect(outcomes.map(outcome => [outcome.status, outcome.count])).toEqual([['replaced', 1], ['replaced', 2], ['conflict', 0], ['conflict', 0]]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await vault.readNote(first.path)).content).toBe('Synthetic confidential Synthetic replaced <perro>');
    expect((await vault.readNote(second.path))).toMatchObject({ content: '<p>Synthetic confidential Synthetic replaced &lt;perro&gt; &amp; Synthetic replaced &lt;perro&gt;</p>', version: outcomes[1].version });
    const disk = await allDisk();
    for (const secret of ['Synthetic confidential', 'Synthetic replaced', 'perro']) expect(disk).not.toContain(secret);
    persist.mockClear();
    expect(await vault.replaceInNotes(options('ausente'), 'x', [{ path: third.path, version: (await vault.readNote(third.path)).version }], id)).toMatchObject([{ status: 'replaced', count: 0 }]);
    expect(persist).not.toHaveBeenCalled();
    expect(() => vault.replaceInNotes(options('gato'), 'x', [{ path: '.oculta/x.md', version: first.version }], id)).toThrow('internas');
  });
});

describe('search worker', () => {
  const slow = options('(a+)+$', { regex: true });
  const content = `${'a'.repeat(40)}b`;
  const timedOut = 'La búsqueda tardó demasiado y se canceló. Simplifica la expresión regular.';

  it('cancels catastrophic backtracking and starts a fresh worker afterwards', async () => {
    await fs.writeFile(path.join(root, 'lenta.md'), content);
    await fs.writeFile(path.join(root, 'otra.md'), content);
    const runner = new SearchRunner(workerFile, 300);
    const vault = new VaultService(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const started = Date.now();
    await expect(vault.searchNotes(slow)).rejects.toThrow(timedOut);
    expect(Date.now() - started).toBeLessThan(3_000);
    const versions = await Promise.all(['lenta.md', 'otra.md'].map(async file => ({ path: file, version: (await vault.readNote(file)).version })));
    expect(await vault.replaceInNotes(slow, 'x', versions)).toEqual(versions.map(({ path: file }) => ({ path: file, status: 'error', count: 0, message: timedOut })));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await fs.readFile(path.join(root, 'lenta.md'), 'utf8')).toBe(content);
    expect((await vault.searchNotes(options('b'))).files).toHaveLength(2);
    runner.dispose();
  });

  it('limits time per note, not per search', async () => {
    const note = `<!doctype html><html><body>${'<p>Lorem ipsum <b>dolor</b> sit &amp; amet.</p>\n'.repeat(8_000)}</body></html>`;
    for (let index = 0; index < 30; index++) await fs.writeFile(path.join(root, `n${index}.html`), note);
    const runner = new SearchRunner(workerFile, 400);
    const vault = new VaultService(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const started = Date.now();
    expect(await vault.searchNotes(options('zzzz'))).toEqual({ files: [], truncated: false });
    expect(Date.now() - started).toBeGreaterThan(400);
    runner.dispose();
  });

  it('skips a slow note for literal queries instead of blaming the pattern', async () => {
    await fs.writeFile(path.join(root, 'nota.md'), 'x');
    const runner = new SearchRunner(workerFile, 1);
    const vault = new VaultService(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    expect(await vault.searchNotes(options('x'))).toEqual({ files: [], truncated: false });
    await expect(vault.searchNotes(options('x', { regex: true }))).rejects.toThrow(timedOut);
    runner.dispose();
  });

  it('returns partial results past the whole-search deadline', async () => {
    const result = await searchFiles(['a.md', 'b.md'], options('x'), () => ({ version: 'v', content: 'x' }), undefined, Date.now() - 1);
    expect(result).toEqual({ files: [], truncated: true });
  });

  it('cancels a runaway pattern in the private vault too', async () => {
    const runner = new SearchRunner(workerFile, 300);
    const vault = new VaultWorkspace(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const id = (await vault.setupPrivateSession('synthetic worker password')).sessionId!; await vault.selectMode('private');
    const note = await vault.createNote('', 'Lenta');
    const saved = await vault.writeNote(note.path, content, note.version, id);
    await expect(vault.searchNotes(slow, id)).rejects.toThrow(timedOut);
    expect(await vault.replaceInNotes(slow, 'x', [{ path: saved.path, version: saved.version }], id)).toMatchObject([{ status: 'error', message: timedOut }]);
    expect((await vault.readNote(saved.path)).content).toBe(content);
    runner.dispose();
  });

  it('terminates the worker and its plaintext when the private vault locks', async () => {
    const runner = new SearchRunner(workerFile, 60_000);
    const vault = new VaultWorkspace(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const id = (await vault.setupPrivateSession('synthetic worker password')).sessionId!; await vault.selectMode('private');
    const note = await vault.createNote('', 'Lenta');
    await vault.writeNote(note.path, `${'a'.repeat(60)}b`, note.version, id);
    const started = Date.now();
    const pending = vault.searchNotes(slow, id);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((runner as unknown as { worker?: unknown }).worker).toBeDefined();
    await vault.lockPrivateSession();
    await expect(pending).rejects.toThrow('bloqueada');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((runner as unknown as { worker?: unknown }).worker).toBeUndefined();
    runner.dispose();
  });

  it('keeps worker error messages and fails clearly without a worker bundle', async () => {
    await expect(search.find('x', 'md', options('(', { regex: true }), 10)).rejects.toThrow('Expresión regular no válida');
    await fs.writeFile(path.join(root, 'nota.md'), 'x');
    const runner = new SearchRunner(path.join(workerFolder, 'falta.cjs'));
    const vault = new VaultService(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    await expect(vault.searchNotes(options('x'))).rejects.toThrow('No se pudo iniciar la búsqueda.');
    runner.dispose();
  });
});

describe('normal vault edge cases', () => {
  let vault: VaultService;
  beforeEach(async () => { vault = new VaultService(root, { watch: false, search }); services.push(vault); await vault.initialize(); });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips unreadable folders without exposing paths', async () => {
    await fs.mkdir(path.join(root, 'Cerrada'));
    await fs.writeFile(path.join(root, 'Cerrada', 'nota.md'), 'gato');
    await fs.writeFile(path.join(root, 'abierta.md'), 'gato');
    await fs.chmod(path.join(root, 'Cerrada'), 0o000);
    try { expect((await vault.searchNotes(options('gato'))).files.map(file => file.path)).toEqual(['abierta.md']); }
    finally { await fs.chmod(path.join(root, 'Cerrada'), 0o755); }
  });

  it('reports stale match ranges as a conflict without writing', async () => {
    await fs.writeFile(path.join(root, 'nota.md'), 'gato gato');
    const [file] = (await vault.searchNotes(options('gato'))).files;
    const outcomes = await vault.replaceInNotes(options('gato'), 'perro', [{ path: file.path, version: file.version, matches: [file.matches[0], { start: 1, end: 5 }] }]);
    expect(outcomes).toMatchObject([{ path: 'nota.md', status: 'conflict', count: 0 }]);
    expect(await fs.readFile(path.join(root, 'nota.md'), 'utf8')).toBe('gato gato');
  });

  it('keeps CRLF line endings in Markdown replacements', async () => {
    await fs.writeFile(path.join(root, 'nota.md'), 'uno\r\ndos\r\n');
    const [file] = (await vault.searchNotes(options('^dos$', { regex: true }))).files;
    expect(file.matches[0]).toMatchObject({ start: 5, end: 8, line: 1 });
    await vault.replaceInNotes(options('(uno)\\n(dos)', { regex: true }), '$2\\n$1', [{ path: file.path, version: file.version }]);
    expect(await fs.readFile(path.join(root, 'nota.md'), 'utf8')).toBe('dos\r\nuno\r\n');
  });
});

describe('search calls and the write queue', () => {
  const slow = options('(a+)+$', { regex: true });
  const content = `${'a'.repeat(40)}b`;
  const workerOf = (runner: SearchRunner) => (runner as unknown as { worker?: unknown }).worker;

  it('terminates the worker when each call finishes', async () => {
    await fs.writeFile(path.join(root, 'nota.md'), 'gato');
    const runner = new SearchRunner(workerFile);
    const vault = new VaultService(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const [file] = (await vault.searchNotes(options('gato'))).files;
    expect(workerOf(runner)).toBeUndefined();
    expect(await vault.replaceInNotes(options('gato'), 'perro', [{ path: file.path, version: file.version }])).toMatchObject([{ status: 'replaced', count: 1, edits: [{ start: 0, end: 4, length: 5 }] }]);
    expect(workerOf(runner)).toBeUndefined();
    runner.dispose();
  });

  it('lets saves through while a normal search runs', async () => {
    await fs.writeFile(path.join(root, 'lenta.md'), content);
    await fs.writeFile(path.join(root, 'otra.md'), 'uno');
    const runner = new SearchRunner(workerFile, 2_000);
    const vault = new VaultService(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const other = await vault.readNote('otra.md');
    let settled = false;
    const pending = vault.searchNotes(slow).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    const started = Date.now();
    await vault.writeNote('otra.md', 'dos', other.version);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(settled).toBe(false);
    await expect(pending).rejects.toThrow('Simplifica');
    runner.dispose();
  });

  it('lets private saves and drafts through while a private search runs', async () => {
    const runner = new SearchRunner(workerFile, 2_000);
    const vault = new VaultWorkspace(root, { watch: false, search: runner }); services.push(vault); await vault.initialize();
    const id = (await vault.setupPrivateSession('synthetic queue password')).sessionId!; await vault.selectMode('private');
    const slowNote = await vault.createNote('', 'Lenta');
    await vault.writeNote(slowNote.path, content, slowNote.version, id);
    const other = await vault.createNote('', 'Otra');
    let settled = false;
    const pending = vault.searchNotes(slow, id).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    const started = Date.now();
    const saved = await vault.writeNote(other.path, 'Synthetic gato', other.version, id);
    await vault.savePrivateDraft(other.path, 'Synthetic gato borrador', saved.version, 1, id);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(settled).toBe(false);
    await expect(pending).rejects.toThrow('Simplifica');
    const [outcome] = await vault.replaceInNotes(options('gato'), '<b>', [{ path: other.path, version: saved.version }], id);
    expect(outcome).toMatchObject({ status: 'replaced', count: 1, edits: [{ start: 10, end: 14, length: 3 }] });
    expect(workerOf(runner)).toBeUndefined();
    runner.dispose();
  });
});
