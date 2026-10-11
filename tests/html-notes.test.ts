import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { counterpartPaths, initialNoteContent, linkTargetFor, noteFormat, withNoteExtension } from '../shared/notes';
import { rewriteWikiLinks } from '../shared/linkUpdates';
import { resolveWikiLink, wikiLinkLabelRange, wikiTargetFor } from '../src/editor/wikilinks';
import { VaultService } from '../electron/storage';
import { VaultWorkspace } from '../electron/vault-workspace';
import { formatHtmlBlocks, joinHtmlDocument, splitHtmlDocument } from '../src/editor/htmlDocument';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { wikiCompletions } from '../src/editor/MarkdownEditor';

describe('note formats', () => {
  it('derives the format from the extension and keeps explicit extensions', () => {
    expect(noteFormat('a/Nota.MD')).toBe('md');
    expect(noteFormat('Nota.html')).toBe('html');
    expect(noteFormat('Nota.htm')).toBeNull();
    expect(withNoteExtension('Nota', 'html')).toBe('Nota.html');
    expect(withNoteExtension('Nota.md', 'html')).toBe('Nota.md');
    expect(counterpartPaths('a/Nota.html')).toEqual(['a/Nota.md']);
    expect(linkTargetFor('a\\Nota.md')).toBe('a/Nota');
    expect(linkTargetFor('a/Nota.html')).toBe('a/Nota.html');
  });

  it('seeds HTML notes with an escaped document skeleton', () => {
    expect(initialNoteContent('Nota.md')).toBe('');
    const html = initialNoteContent('Carpeta/<A & B>.html');
    expect(html).toContain('<title>&lt;A &amp; B&gt;</title>');
    expect(html).toContain('<meta name="generator" content="Black Cobble">');
  });
});

describe('wikilinks across formats', () => {
  const notes = ['Diario.md', 'Pagina.html', 'Docs/Guia.html', 'Docs/Guia2.md'];
  it('resolves bare names to Markdown first, then HTML', () => {
    expect(resolveWikiLink('Diario', 'X.md', notes)).toBe('Diario.md');
    expect(resolveWikiLink('Pagina', 'X.md', notes)).toBe('Pagina.html');
    expect(resolveWikiLink('Pagina.html', 'X.md', notes)).toBe('Pagina.html');
    expect(resolveWikiLink('Pagina.md', 'X.md', notes)).toBeNull();
    expect(resolveWikiLink('Guia', 'X.md', notes)).toBe('Docs/Guia.html');
    expect(resolveWikiLink('./Guia2', 'Docs/Guia.html', notes)).toBe('Docs/Guia2.md');
  });
  it('completes every note with a target that resolves back to it', () => {
    const paths = ['Nota.md', 'sub/Nota.md', 'sub/Origen.md', 'Web.html', 'sub/Web.html', 'otra/sub/Nota.md'];
    expect(wikiTargetFor('Nota.md', 'sub/Origen.md', paths)).toBe('/Nota');
    expect(wikiTargetFor('Web.html', 'sub/Origen.md', paths)).toBe('/Web.html');
    expect(wikiTargetFor('sub/Nota.md', 'sub/Origen.md', paths)).toBe('sub/Nota');
    expect(wikiTargetFor('Nota.md', 'Raiz.md', paths)).toBe('Nota');
    for (const source of [...paths, 'Raiz.md', 'otra/X.html']) {
      for (const note of paths) expect(resolveWikiLink(wikiTargetFor(note, source, paths), source, paths), `${note} from ${source}`).toBe(note);
    }
  });
  it('hides either extension from the visible label', () => {
    const target = 'Docs/Guia.html';
    const range = wikiLinkLabelRange(target);
    expect(target.slice(range.from, range.to)).toBe('Guia');
  });
});

describe('rewriteWikiLinks in HTML notes', () => {
  it('rewrites only data-wikilink attributes and keeps every other byte', () => {
    const content = '<!doctype html>\r\n<html><head><title>Ñandú</title></head>\r\n<body>\r\n<p>Ver <a class="wikilink" data-wikilink="Old#Parte">mi enlace</a> 🙂</p>\r\n<pre><code>&lt;a data-wikilink="Old"&gt;</code></pre>\r\n<!-- <a data-wikilink="Old"> -->\r\n<a data-wikilink=\'Other\'>x</a>\r\n</body></html>\r\n';
    const paths = ['Source.html', 'Old.md', 'Other.md'];
    const result = rewriteWikiLinks(content, 'Source.html', 'Source.html', paths, new Map([['Old.md', 'Nuevo/Old & "B".md']]));
    expect(result).toBe(content.replace('data-wikilink="Old#Parte"', 'data-wikilink="Nuevo/Old &amp; &quot;B&quot;#Parte"'));
  });

  it('repairs links from a moved HTML note and keeps Markdown rewrites for .md sources', () => {
    const paths = ['A/Source.html', 'A/Target.md', 'B/Target.md'];
    const moves = new Map([['A/Source.html', 'B/Source.html']]);
    expect(rewriteWikiLinks('<a data-wikilink="Target">t</a>', 'A/Source.html', 'B/Source.html', paths, moves)).toBe('<a data-wikilink="A/Target">t</a>');
    // A moved basename still resolves; a renamed one is rewritten with its extension kept.
    expect(rewriteWikiLinks('[[Pagina.html|p]]', 'X.md', 'X.md', ['X.md', 'Pagina.html'], new Map([['Pagina.html', 'Web/Pagina.html']]))).toBe('[[Pagina.html|p]]');
    expect(rewriteWikiLinks('[[Pagina.html|p]]', 'X.md', 'X.md', ['X.md', 'Pagina.html'], new Map([['Pagina.html', 'Portada.html']]))).toBe('[[/Portada.html|p]]');
  });
});

describe('storage with HTML notes', () => {
  let temporary: string;
  let vault: VaultService;
  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'boveda-html-'));
    vault = new VaultService(temporary, { watch: false, trash: async absolute => { await fs.rm(absolute); } });
    await vault.initialize();
  });
  afterEach(async () => { await vault.dispose(); await fs.rm(temporary, { recursive: true, force: true }); });

  it('creates, lists, edits and renames HTML notes next to Markdown ones', async () => {
    const html = await vault.createNote('', 'Pagina', 'html');
    expect(html.path).toBe('Pagina.html');
    expect(html.content).toContain('<title>Pagina</title>');
    const md = await vault.createNote('', 'Diario');
    await vault.writeNote(md.path, 'Ver [[Pagina.html]]', md.version);
    expect((await vault.listEntries()).map(entry => entry.name)).toEqual(['Diario.md', 'Pagina.html']);
    expect(await vault.renameEntry('Pagina.html', 'Portada')).toBe('Portada.html');
    expect((await vault.readNote('Diario.md')).content).toBe('Ver [[/Portada.html]]');
    await expect(vault.renameEntry('Portada.html', 'Portada.md')).rejects.toThrow('formato');
    await expect(vault.createNote('', 'Nota', 'txt' as 'md')).rejects.toThrow('Formato');
  });

  it('rejects a second note with the same name in another format', async () => {
    await vault.createNote('', 'Nota', 'html');
    await expect(vault.createNote('', 'Nota')).rejects.toThrow('otro formato');
    await vault.createFolder('', 'Otra');
    await vault.createNote('Otra', 'Nota');
    await expect(vault.moveEntry('Otra/Nota.md', '')).rejects.toThrow('otro formato');
    await vault.createNote('', 'Libre');
    await expect(vault.renameEntry('Libre.md', 'Nota')).rejects.toThrow('otro formato');
  });
});

describe('private vault with HTML notes', () => {
  let root: string;
  let vault: VaultWorkspace;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'private-html-')); vault = new VaultWorkspace(root, { watch: false }); await vault.initialize(); });
  afterEach(async () => { await vault.dispose(); await fs.rm(root, { recursive: true, force: true }); });

  it('stores encrypted HTML notes and enforces the same naming rules', async () => {
    const id = (await vault.setupPrivateSession('synthetic html password')).sessionId!;
    await vault.selectMode('private');
    const note = await vault.createNote('', 'Secreta', 'html');
    expect(note.path).toBe('Secreta.html');
    expect(note.content).toContain('<!doctype html>');
    await vault.writeNote(note.path, '<p>texto secreto</p>', note.version, id);
    await expect(vault.createNote('', 'Secreta')).rejects.toThrow('otro formato');
    await expect(vault.renameEntry('Secreta.html', 'Secreta.md')).rejects.toThrow('formato');
    await vault.dispose();
    vault = new VaultWorkspace(root, { watch: false }); await vault.initialize(); await vault.selectMode('private');
    await vault.unlockPrivateSession('synthetic html password');
    expect((await vault.readNote('Secreta.html')).content).toBe('<p>texto secreto</p>');
  });
});

describe('HTML document helpers', () => {
  it('splits the body from the doctype and head and joins it back', () => {
    const content = '<!doctype html>\n<html>\n<head><title>T</title></head>\n<BODY class="x">\n<p>a</p>\n</body>\n</html>\n';
    const parts = splitHtmlDocument(content);
    expect(parts.before.endsWith('<BODY class="x">')).toBe(true);
    expect(parts.body).toBe('\n<p>a</p>\n');
    expect(joinHtmlDocument(parts, '<p>a</p>')).toBe(content);
    expect(splitHtmlDocument('<p>fragmento</p>')).toEqual({ before: '', body: '<p>fragmento</p>', after: '' });
    expect(joinHtmlDocument(splitHtmlDocument('<p>x</p>'), '<p>y</p>')).toBe('<p>y</p>');
  });

  it('finds the real body, never a tag-like string in comments, scripts or attributes', () => {
    const head = '<!doctype html><html><head><!-- ejemplo <body> para documentación --><title>Mi título</title><meta content="<body>"></head><body>';
    const tail = '</body></html>';
    const body = '<p>Texto</p><script>var s = "</body>"</script>';
    expect(splitHtmlDocument(head + body + tail)).toEqual({ before: head, body, after: tail });
    // A stray </body> after a comment that mentions it still ends the body at the real tag.
    expect(splitHtmlDocument('<body><p>a</p></body>\n<!-- </body> -->\n</html>\n').after).toBe('</body>\n<!-- </body> -->\n</html>\n');
  });

  it('keeps the head of a document without a <body> tag outside the editable body', () => {
    const content = '<!doctype html><html><head><title>T</title></head><p>sin body</p></html>\n';
    expect(splitHtmlDocument(content)).toEqual({ before: '<!doctype html><html><head><title>T</title></head>', body: '<p>sin body</p>', after: '</html>\n' });
    expect(splitHtmlDocument('<!-- c --><title>x</title><p>y</p>')).toEqual({ before: '<!-- c --><title>x</title>', body: '<p>y</p>', after: '' });
    expect(splitHtmlDocument('<!doctype html><html><head></head></html>')).toEqual({ before: '<!doctype html><html><head></head>', body: '', after: '</html>' });
  });

  it('puts one block per line without touching inline or preformatted text', () => {
    const html = '<h1>T</h1><p>a<br>b <strong>c</strong></p><ul><li><p>1</p></li></ul><pre><code>x\n&lt;/p&gt;y</code></pre>';
    const formatted = formatHtmlBlocks(html);
    expect(formatted).toBe('<h1>T</h1>\n<p>a<br>b <strong>c</strong></p>\n<ul>\n<li><p>1</p>\n</li>\n</ul>\n<pre><code>x\n&lt;/p&gt;y</code></pre>');
    expect(formatHtmlBlocks(formatted)).toBe(formatted);
  });

  it('completes HTML targets with their extension from Markdown notes', () => {
    const state = EditorState.create({ doc: '[[Pag', extensions: [markdown()] });
    const completion = wikiCompletions(new CompletionContext(state, 5, false), ['Pagina.html', 'Diario.md']);
    expect(completion?.options.map(option => option.label)).toEqual(['Diario', 'Pagina.html']);
  });
});
