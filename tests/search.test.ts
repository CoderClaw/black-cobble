import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { applyReplacements, compareNotePaths, expandReplacement, findMatches, matchesGlobs, MAX_QUERY_LENGTH, MAX_SEARCH_MATCHES, searchFiles, searchPattern, type SearchOptions } from '../shared/search';

const options = (query: string, extra: Partial<SearchOptions> = {}): SearchOptions => ({ query, matchCase: false, wholeWord: false, regex: false, ...extra });
const ranges = (content: string, query: string, extra: Partial<SearchOptions> = {}, format: 'md' | 'html' = 'md') =>
  findMatches(content, format, options(query, extra)).map(match => content.slice(match.start, match.end));

describe('search patterns', () => {
  it('matches literally, ignoring case unless asked', () => {
    expect(ranges('Año a.b AÑO axb', 'año')).toEqual(['Año', 'AÑO']);
    expect(ranges('Año a.b AÑO axb', 'año', { matchCase: true })).toEqual([]);
    expect(ranges('a.b axb (x) $1', 'a.b')).toEqual(['a.b']);
    expect(ranges('(x) [y] $1 a/b', '(x) [y] $1 a/b')).toEqual(['(x) [y] $1 a/b']);
  });

  it('uses Unicode-aware whole words', () => {
    expect(ranges('canción cancionero canción_x canción.', 'canción', { wholeWord: true })).toEqual(['canción', 'canción']);
    expect(ranges('añoranza año', 'año', { wholeWord: true })).toEqual(['año']);
    expect(ranges('ção caçar', 'ca', { wholeWord: true })).toEqual([]);
    expect(ranges('x foo|bar y', 'foo|bar', { regex: true, wholeWord: true })).toEqual(['foo', 'bar']);
  });

  it('supports regex flags per line and rejects invalid patterns in Spanish', () => {
    expect(ranges('uno\ndos\r\ntres', '^\\w+$', { regex: true })).toEqual(['uno', 'dos', 'tres']);
    expect(() => searchPattern(options('(', { regex: true }))).toThrow(/^Expresión regular no válida: /);
    expect(searchPattern(options(''))).toBeNull();
    expect(() => searchPattern(options('x'.repeat(MAX_QUERY_LENGTH + 1)))).toThrow('demasiado larga');
  });

  it('skips zero-length matches without splitting surrogate pairs', () => {
    expect(ranges('🙂a🙂', 'a*', { regex: true })).toEqual(['a']);
    expect(ranges('🙂🙂', '(?=🙂)', { regex: true })).toEqual([]);
    expect(ranges('x🙂y', '.', { regex: true })).toEqual(['x', '🙂', 'y']);
  });

  it('reports lines and single-line previews', () => {
    const content = `primera\r\nsegunda línea con ${'relleno '.repeat(10)}objetivo final\n\ttercera objetivo`;
    const [first, second] = findMatches(content, 'md', options('objetivo'));
    expect(first.line).toBe(1);
    expect(first.preview.before.startsWith('…')).toBe(true);
    expect(first.preview.before.length).toBeLessThanOrEqual(41);
    expect(first.preview).toMatchObject({ text: 'objetivo', after: ' final' });
    expect(second).toMatchObject({ line: 2, preview: { before: 'tercera ', text: 'objetivo', after: '' } });
    expect(findMatches('a\nb\nc', 'md', options('b\\nc', { regex: true }))[0].preview).toEqual({ before: '', text: 'b', after: '' });
  });

  it('stops at the requested limit', () => {
    expect(findMatches('a'.repeat(20), 'md', options('a'), 5)).toHaveLength(5);
    expect(MAX_SEARCH_MATCHES).toBe(10_000);
  });
});

describe('replacements', () => {
  it('expands regex groups like VS Code and keeps literal replacements verbatim', () => {
    const match = /(?<year>\d{4})-(\d{2})/u.exec('2024-05')!;
    expect(expandReplacement('$2/$1 $<year> $& $$ $0 $9 $<none> \\n\\t\\\\ \\x', match)).toBe('05/2024 2024 2024-05 $ 2024-05 $9  \n\t\\ \\x');
    expect(expandReplacement('$<name>', /(a)/u.exec('a')!)).toBe('$<name>');
    expect(applyReplacements('2024-05 y 1999-12', 'md', options('(\\d{4})-(\\d{2})', { regex: true }), '$2/$1')).toMatchObject({ content: '05/2024 y 12/1999', count: 2 });
    expect(applyReplacements('a.b a.b', 'md', options('a.b'), '$&\\n')).toMatchObject({ content: '$&\\n $&\\n', count: 2 });
    expect(applyReplacements('sin nada', 'md', options('zzz'), 'x')).toMatchObject({ content: 'sin nada', count: 0 });
  });

  it('replaces only the selected ranges', () => {
    const content = 'gato gato gato';
    const matches = findMatches(content, 'md', options('gato'));
    expect(applyReplacements(content, 'md', options('gato'), 'perro', [matches[1]])).toMatchObject({ content: 'gato perro gato', count: 1 });
  });
});

describe('HTML notes', () => {
  const page = (body: string, head = '<title>objetivo</title><style>.objetivo{}</style>') => `<!doctype html>\n<html><head>${head}</head>\n<body>${body}</body></html>\n`;

  it('searches only visible body text', () => {
    const content = page('<p class="objetivo" title="objetivo">uno objetivo</p><!-- objetivo --><script>objetivo()</script><style>p{}</style><template>objetivo</template><p>objetivo</p>');
    const matches = findMatches(content, 'html', options('objetivo'));
    expect(matches.map(match => content.slice(match.start, match.end))).toEqual(['objetivo', 'objetivo']);
    expect(matches[0].preview).toEqual({ before: 'uno ', text: 'objetivo', after: '' });
    expect(ranges(content, 'class', {}, 'html')).toEqual([]);
  });

  it('maps decoded entities back to whole source units', () => {
    const content = page('<p>Tom &amp; Jerry&nbsp;bail&#233; caf&eacute; &#x1F600;!</p>');
    const raw = (query: string, extra: Partial<SearchOptions> = {}) => ranges(content, query, extra, 'html');
    expect(raw('Tom & Jerry')).toEqual(['Tom &amp; Jerry']);
    expect(raw('Jerry bailé')).toEqual(['Jerry&nbsp;bail&#233;']);
    expect(raw('café 😀', { wholeWord: true })).toEqual(['caf&eacute; &#x1F600;']);
    expect(raw('amp')).toEqual([]);
    expect(findMatches(content, 'html', options('café'))[0].preview).toEqual({ before: 'Tom & Jerry bailé ', text: 'café', after: ' 😀!' });
  });

  it('skips matches that split an entity and do not cross text nodes', () => {
    const content = page('<p>&NotEqualTilde; can<b>ción</b></p>');
    expect(ranges(content, '̸', { regex: true }, 'html')).toEqual([]);
    expect(ranges(content, '≂̸', { regex: true }, 'html')).toEqual(['&NotEqualTilde;']);
    expect(ranges(content, 'canción', {}, 'html')).toEqual([]);
  });

  it('handles CRLF, attributes-free source and line numbers', () => {
    const content = '<p>uno\r\ndos &lt;tres&gt;</p>\r\n<p>cuatro</p>';
    const matches = findMatches(content, 'html', options('dos <tres>'));
    expect(content.slice(matches[0].start, matches[0].end)).toBe('dos &lt;tres&gt;');
    expect(matches[0].line).toBe(1);
    expect(findMatches(content, 'html', options('cuatro'))[0].line).toBe(2);
  });

  it('escapes HTML replacements and keeps the document structure', () => {
    const content = page('<p class="x">a &amp; b</p><script>a()</script>');
    const result = applyReplacements(content, 'html', options('a'), '<i>&</i>');
    expect(result.count).toBe(1);
    expect(result.content).toBe(page('<p class="x">&lt;i&gt;&amp;&lt;/i&gt; &amp; b</p><script>a()</script>'));
    const regex = applyReplacements(page('<p>Tom &amp; Jerry</p>'), 'html', options('(\\w+) & (\\w+)', { regex: true }), '$2 <$1>');
    expect(regex.content).toBe(page('<p>Jerry &lt;Tom&gt;</p>'));
  });

  it('never turns a bare & or < into a reference or a tag', () => {
    const content = '<p>a &x nbsp; b <_p>x</p>';
    expect(findMatches(content, 'html', options('x ')).length).toBe(1);
    const result = applyReplacements(applyReplacements(content, 'html', options('x '), '').content, 'html', options('_'), '');
    expect(result.content).toBe('<p>a &amp;nbsp; b &lt;p&gt;x</p>');
    expect(findMatches(result.content, 'html', options('&nbsp; b <p>x')).length).toBe(1);
    expect(applyReplacements('<p>&x</p>', 'html', options('&x'), '').content).toBe('<p></p>');
  });
});

describe('HTML rewrites keep every other character', () => {
  const visible = (html: string) => {
    let text = '';
    const visit = (node: { childNodes?: unknown[] }) => { for (const child of (node.childNodes ?? []) as Array<{ nodeName: string; value?: string; childNodes?: unknown[] }>) { if (child.nodeName === '#text') text += child.value; else visit(child); } };
    visit(parse(html));
    return text;
  };
  it.each([
    ['<p>&ltXimes;</p>', 'X', '', '<imes;'],
    ['<p>&notiXn;</p>', 'X', '', '¬in;'],
    ['<p>&#65X0;</p>', 'X', '', 'A0;'],
    ['<p>&lXt;</p>', 'X', '', '&lt;'],
    ['<p>&aX</p>', 'X', 'mp;', '&amp;'],
    ['<p>&Xlt;</p>', 'X', '', '&lt;'],
    ['<p><1b>x</p>', '1', '', '<b>x'],
    ['<p>a &amp; bX c</p>', 'X', '', 'a & b c'],
    ['<pre>X\nfoo</pre>', 'X', '', '\nfoo'],
    ['<pre>\nX\nfoo</pre>', 'X', '', '\nfoo'],
    ['<listing>X\nfoo</listing>', 'X', '', '\nfoo'],
  ])('%s: %s → %s', (html, query, replacement, expected) => {
    const result = applyReplacements(html, 'html', options(query, { matchCase: true }), replacement);
    expect(result.count).toBe(1);
    expect(visible(result.content)).toBe(expected);
  });

  it('keeps untouched entities when the edit is safe', () => {
    expect(applyReplacements('<p>caf&eacute; X &amp;</p>', 'html', options('X'), 'Y').content).toBe('<p>caf&eacute; Y &amp;</p>');
  });

  it('rewrites foster-parented text in source order', () => {
    const content = '<table><tr><td>gato</td></tr>gato</table>';
    const starts = findMatches(content, 'html', options('gato')).map(match => match.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(applyReplacements(content, 'html', options('gato'), 'perro')).toMatchObject({ content: '<table><tr><td>perro</td></tr>perro</table>', count: 2 });
  });
});

describe('Markdown line breaks', () => {
  it("reads CRLF as one line break and writes the note's own", () => {
    expect(applyReplacements('a\r\n\r\nb', 'md', options('^\\n', { regex: true }), '')).toMatchObject({ content: 'a\r\nb', count: 1 });
    const content = 'foo\r\nbar\r\nfoo';
    expect(ranges(content, 'foo$', { regex: true })).toEqual(['foo', 'foo']);
    expect(ranges(content, 'foo\\nbar', { regex: true })).toEqual(['foo\r\nbar']);
    expect(findMatches(content, 'md', options('bar'))[0]).toMatchObject({ start: 5, end: 8, line: 1 });
    expect(applyReplacements(content, 'md', options('(foo)\\n(bar)', { regex: true }), '$2\\n$1').content).toBe('bar\r\nfoo\r\nfoo');
    expect(applyReplacements('a\nb\r\nc\nd', 'md', options('b', { regex: true }), 'x\\ny').content).toBe('a\nx\ny\r\nc\nd');
  });
});

describe('replacement safety', () => {
  it('rejects a whole-word regex that would escape its wrapper', () => {
    expect(() => searchPattern(options('xx)|(bar', { regex: true, wholeWord: true }))).toThrow('Expresión regular no válida');
  });

  it('reports ranges that no longer match as a conflict', () => {
    expect(() => applyReplacements('gato gato', 'md', options('gato'), 'perro', [{ start: 0, end: 4 }, { start: 1, end: 5 }])).toThrow(/^CONFLICT:/);
    expect(() => applyReplacements('<p>gato</p>', 'html', options('gato'), 'perro', [{ start: 0, end: 4 }])).toThrow(/^CONFLICT:/);
  });

  it('stops before the output exceeds the note size limit', () => {
    expect(() => applyReplacements('x'.repeat(2000), 'md', options('x'), 'y'.repeat(20_000))).toThrow('tamaño máximo');
  });
});

describe('replacement edits', () => {
  /** Edits must explain every changed character: outside them old and new text are identical. */
  const replay = (before: string, result: { content: string; edits: Array<{ start: number; end: number; length: number }> }) => {
    let shift = 0;
    let last = 0;
    for (const edit of result.edits) {
      expect(edit.start).toBeGreaterThanOrEqual(last);
      expect(result.content.slice(last + shift, edit.start + shift)).toBe(before.slice(last, edit.start));
      shift += edit.length - (edit.end - edit.start);
      last = edit.end;
    }
    expect(result.content.slice(last + shift)).toBe(before.slice(last));
  };

  it('reports Markdown edits with the written length, including CRLF expansion', () => {
    const result = applyReplacements('gato y gato', 'md', options('gato'), 'perro');
    expect(result.edits).toEqual([{ start: 0, end: 4, length: 5 }, { start: 7, end: 11, length: 5 }]);
    replay('gato y gato', result);
    const crlf = 'uno\r\ndos\r\n';
    const swapped = applyReplacements(crlf, 'md', options('(uno)\\n(dos)', { regex: true }), '$2\\n$1');
    expect(swapped.edits).toEqual([{ start: 0, end: 8, length: 8 }]);
    replay(crlf, swapped);
  });

  it('reports escaped HTML lengths and whole-node rewrites', () => {
    const escaped = '<p>a &amp; b a</p>';
    const result = applyReplacements(escaped, 'html', options('a', { matchCase: true, wholeWord: true }), '<i>');
    expect(result.edits).toEqual([{ start: 3, end: 4, length: 9 }, { start: 13, end: 14, length: 9 }]);
    replay(escaped, result);
    const joined = '<p>x &ltXimes; y</p><p>X</p>';
    const fallback = applyReplacements(joined, 'html', options('X', { matchCase: true }), '');
    expect(fallback.edits).toEqual([{ start: 3, end: 16, length: fallback.content.indexOf('</p>') - 3 }, { start: 23, end: 24, length: 0 }]);
    replay(joined, fallback);
    const pre = '<pre>X\nfoo</pre>';
    const leading = applyReplacements(pre, 'html', options('X'), '');
    expect(leading).toMatchObject({ content: '<pre>\n\nfoo</pre>', edits: [{ start: 5, end: 10, length: 5 }] });
    replay(pre, leading);
  });
});

describe('path filters', () => {
  it('matches pathological globs in linear time', () => {
    const started = Date.now();
    expect(matchesGlobs(`Carpeta/${'a'.repeat(200)}.md`, `${'*a'.repeat(400)}b`)).toBe(false);
    expect(matchesGlobs(`${'a/'.repeat(100)}x.md`, `${'**/a'.repeat(100)}/x.md`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('matches comma-separated globs by segment or by path', () => {
    expect(matchesGlobs('Proyectos/2024/nota.md', 'proyectos')).toBe(true);
    expect(matchesGlobs('Otros/Proyectos/nota.md', 'Proyectos')).toBe(true);
    expect(matchesGlobs('MisProyectos/nota.md', 'Proyectos')).toBe(false);
    expect(matchesGlobs('a/b/página.HTML', '*.html')).toBe(true);
    expect(matchesGlobs('a/b/nota.md', ' *.html , b ')).toBe(true);
    expect(matchesGlobs('a/b/nota.md', 'a/*.md')).toBe(false);
    expect(matchesGlobs('a/b/nota.md', 'a/**/*.md')).toBe(true);
    expect(matchesGlobs('nota.md', '**/*.md')).toBe(true);
    expect(matchesGlobs('a/nota1.md', 'nota?.md')).toBe(true);
    expect(matchesGlobs('a/nota.md', '', 'a')).toBe(false);
    expect(matchesGlobs('a/nota.md', '  ', ' , ')).toBe(true);
    expect(matchesGlobs('a+b/(x).md', 'a+b/(x).md')).toBe(true);
  });

  it('orders results like the tree and truncates at the match limit', async () => {
    expect(['b.md', 'a/z.md', 'Nota 10.md', 'nota 2.md', 'A/b/c.md'].sort(compareNotePaths)).toEqual(['A/b/c.md', 'a/z.md', 'b.md', 'nota 2.md', 'Nota 10.md']);
    const notes: Record<string, string> = { 'b.md': 'x'.repeat(MAX_SEARCH_MATCHES - 1), 'a.md': 'x', 'c.md': 'x', 'd.txt': 'x' };
    const result = await searchFiles(Object.keys(notes), options('x'), path => ({ version: path, content: notes[path] }));
    expect(result.truncated).toBe(true);
    expect(result.files.map(file => [file.path, file.matches.length])).toEqual([['a.md', 1], ['b.md', MAX_SEARCH_MATCHES - 1]]);
    const exact = await searchFiles(['a.md', 'b.md'], options('x'), path => ({ version: path, content: notes[path] }));
    expect(exact.truncated).toBe(false);
  });
});
