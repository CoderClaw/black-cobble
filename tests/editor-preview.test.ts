import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { blockedImageLabel, buildPreview, imageSourceStatus, isCodePosition, previewOptions, privateImageLabel, remoteImageSource, safeImageSource } from '../src/editor/livePreview';

function state(doc: string, cursor = doc.length, sourceMode = false) {
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdown({ extensions: GFM }), previewOptions.of({ sourceMode, notePath: 'Current.md', notePaths: ['Target.md'] })] });
}

function decorations(editor: EditorState) {
  const found: { from: number; to: number; className?: string; widget?: unknown; attrs?: Record<string, string> }[] = [];
  buildPreview(editor).between(0, editor.doc.length, (from, to, value) => {
    found.push({ from, to, className: value.spec.class, widget: value.spec.widget, attrs: value.spec.attributes });
  });
  return found;
}

function visibleText(editor: EditorState): string {
  const hidden = decorations(editor).filter(item => item.from < item.to && !item.className && !item.widget).sort((a, b) => b.from - a.from);
  let visible = editor.doc.toString();
  for (const range of hidden) visible = visible.slice(0, range.from) + visible.slice(range.to);
  return visible;
}

describe('Markdown live preview', () => {
  it('hides formatting on inactive lines and keeps it visible on the cursor line', () => {
    const doc = '# Heading\n**Bold** and *italic*\nEditing';
    const inactive = decorations(state(doc));
    expect(inactive.some(item => item.from === 0 && item.to === 2)).toBe(true);
    expect(inactive.some(item => item.className === 'cm-md-strong')).toBe(true);
    const cursorLine = decorations(state(doc, 13));
    expect(cursorLine.filter(item => item.from >= 10 && item.to <= 31 && item.from !== item.to).every(item => Boolean(item.className))).toBe(true);
  });
  it('renders wiki aliases and distinguishes unresolved notes', () => {
    const items = decorations(state('[[Target|Alias]] [[Missing]]\nEdit'));
    expect(items.find(item => item.attrs?.['data-wiki-target'] === 'Target|Alias')?.className).toBe('cm-wiki-link');
    expect(items.find(item => item.attrs?.['data-wiki-target'] === 'Missing')?.className).toContain('cm-wiki-unresolved');
    expect(items.some(item => item.from === 0 && item.to === 9)).toBe(true);
  });
  it('shows only the basename while keeping the full navigation target and Markdown', () => {
    const doc = '[[programacion/js.md#Funciones]]\nEdit';
    const editor = state(doc);
    expect(visibleText(editor)).toBe('js\nEdit');
    expect(decorations(editor).find(item => item.attrs?.['data-wiki-target'])?.attrs?.['data-wiki-target']).toBe('programacion/js.md#Funciones');
    expect(editor.doc.toString()).toBe(doc);
  });
  it('shows aliases and falls back to basename for empty aliases', () => {
    expect(visibleText(state('[[ carpeta/Nota.md | Nombre visible ]] [[carpeta/Otra.md| ]]\nEdit'))).toBe('Nombre visible Otra\nEdit');
    expect(visibleText(state('[[carpeta\\Nota.md]] [[#Detalles]]\nEdit'))).toBe('Nota Detalles\nEdit');
  });
  it('reveals the full wiki syntax when its line is active or source mode is enabled', () => {
    const doc = '[[programacion/js.md]]\nEdit';
    expect(visibleText(state(doc, 10))).toBe(doc);
    expect(visibleText(state(doc, doc.length, true))).toBe(doc);
  });
  it('keeps wikilinks literal inside fenced, indented and inline code', () => {
    const doc = '```md\n[[Target]]\n```\n\n    [[Target]]\n\n`[[Target]]`\n\n[[Target]]\nEdit';
    const editor = state(doc);
    expect(isCodePosition(editor, doc.indexOf('[[Target]]') + 2)).toBe(true);
    expect(decorations(editor).filter(item => item.className === 'cm-wiki-link')).toHaveLength(1);
  });
  it('parses code beyond the initial syntax-tree budget', () => {
    const doc = `${'A long note paragraph.\n\n'.repeat(600)}\`\`\`md\n[[Target]]\n\`\`\`\nEdit`;
    expect(decorations(state(doc)).filter(item => item.attrs?.['data-wiki-target'])).toHaveLength(0);
  });
  it('does not convert escaped wiki brackets to navigation', () => {
    expect(decorations(state('\\[[Target]]\nEdit')).some(item => item.attrs?.['data-wiki-target'])).toBe(false);
  });
  it('preserves the underlying Markdown and clears decoration in source mode', () => {
    const doc = '# Heading\n- [x] Task\n[[Target]]';
    const editor = state(doc, doc.length, true);
    expect(buildPreview(editor).size).toBe(0);
    expect(editor.doc.toString()).toBe(doc);
  });
  it('leaves syntax visible on every selected line', () => {
    const initial = state('**First**\n*Second*\nThird');
    const selected = initial.update({ selection: { anchor: 1, head: 16 } }).state;
    expect(decorations(selected).some(item => item.from < 18 && !item.className && item.from < item.to)).toBe(false);
  });
  it('previews safe images without evaluating HTML or script destinations', () => {
    expect(safeImageSource('https://example.test/photo.png')).toBe(true);
    expect(safeImageSource('http://example.test/photo.png')).toBe(false);
    expect(safeImageSource('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(safeImageSource('javascript:alert(1)')).toBe(false);
    expect(safeImageSource('file:///private/photo.png')).toBe(false);
    expect(safeImageSource('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(decorations(state('![A photo](https://example.test/photo.png)\nEdit')).some(item => item.widget)).toBe(true);
    expect(decorations(state('<script>alert(1)</script>\nEdit')).some(item => item.widget)).toBe(false);
  });
  describe('image source policy (HTTPS only)', () => {
    const cases: Array<[string, 'allowed' | 'insecure' | 'rejected']> = [
      ['https://example.test/a.png', 'allowed'],
      ['HTTPS://example.test/a.png', 'allowed'],
      ['data:image/png;base64,iVBORw0KGgo=', 'allowed'],
      ['http://example.test/a.png', 'insecure'],
      ['HTTP://example.test/a.png', 'insecure'],
      ['javascript:alert(1)', 'rejected'],
      ['file:///private/a.png', 'rejected'],
      ['data:image/svg+xml;base64,PHN2Zz4=', 'rejected'],
      ['relative/a.png', 'rejected'],
    ];
    it.each(cases)('classifies %s as %s', (source, status) => {
      expect(imageSourceStatus(source)).toBe(status);
      expect(safeImageSource(source)).toBe(status === 'allowed');
    });
    it('explains why an image is not loaded, keeping the alternative text', () => {
      expect(blockedImageLabel('http://example.test/a.png', '')).toBe('Imagen HTTP no cargada: solo se cargan imágenes HTTPS');
      expect(blockedImageLabel('http://example.test/a.png', ' Foto ')).toBe('Imagen HTTP no cargada: solo se cargan imágenes HTTPS (Foto)');
      expect(blockedImageLabel('file:///a.png', '')).toBe('Imagen no cargada: origen no admitido');
    });
    const widgetFor = (doc: string, privateMode = false) => {
      const editor = EditorState.create({ doc: `${doc}\nEdit`, selection: { anchor: doc.length + 5 }, extensions: [markdown({ extensions: GFM }), previewOptions.of({ sourceMode: false, notePath: 'Current.md', notePaths: [], privateMode })] });
      return decorations(editor).find(item => item.widget)?.widget as { source?: string; label?: string } | undefined;
    };
    it('shows loadable images for HTTPS and data sources', () => {
      expect(widgetFor('![Foto](https://example.test/a.png)')?.source).toBe('https://example.test/a.png');
      expect(widgetFor('![Foto](data:image/png;base64,iVBORw0KGgo=)')?.source).toMatch(/^data:image\/png/);
    });
    it('replaces HTTP and rejected sources with an accessible marker instead of an image', () => {
      expect(widgetFor('![Foto](http://example.test/a.png)')).toMatchObject({ label: 'Imagen HTTP no cargada: solo se cargan imágenes HTTPS (Foto)' });
      expect(widgetFor('![](http://example.test/a.png)')).not.toHaveProperty('source');
      expect(widgetFor('![Foto](file:///a.png)')).toMatchObject({ label: 'Imagen no cargada: origen no admitido (Foto)' });
    });
    it('keeps remote HTTPS images as an explicit link in private vaults and never loads HTTP', () => {
      expect(widgetFor('![Foto](https://example.test/a.png)', true)).toBeUndefined();
      expect(widgetFor('![Foto](http://example.test/a.png)', true)).toHaveProperty('label');
    });
    it('detects remote sources the way the browser parses them, so private vaults cannot be bypassed', () => {
      for (const source of ['https://example.test/a.png', 'HTTPS://example.test/a.png', ' https://example.test/a.png', '\thttps://example.test/a.png', '\u0001https://example.test/a.png', '\u0000https://example.test/a.png', 'http://example.test/a.png'])
        expect(remoteImageSource(source)).toBe(true);
      for (const source of ['data:image/png;base64,iVBORw0KGgo=', 'file:///a.png', 'a.png'])
        expect(remoteImageSource(source)).toBe(false);
      for (const doc of ['![Foto](\u0001https://example.test/a.png)', '![Foto](\u0000https://example.test/a.png)']) {
        expect(widgetFor(doc)).toHaveProperty('source');
        expect(widgetFor(doc, true)).toBeUndefined();
      }
    });
    it('keeps the alternative text when a private vault blocks a remote image', () => {
      expect(privateImageLabel('')).toBe('Imagen remota bloqueada en la bóveda privada');
      expect(privateImageLabel(' Foto privada ')).toBe('Imagen remota bloqueada en la bóveda privada (Foto privada)');
    });
  });
});
