import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { headingPosition, wikiCompletions } from '../src/editor/MarkdownEditor';

const paths = ['folder/Ideas.md', 'Inicio.md'];
const complete = (doc: string, position = doc.length) => wikiCompletions(new CompletionContext(EditorState.create({ doc, extensions: [markdown()] }), position, false), paths);

describe('wiki autocompletion', () => {
  it('completes note paths after opening brackets, including spaces', () => {
    const completion = complete('A note with [[folder/Ideas nuevas');
    expect(completion?.from).toBe(14);
    expect(completion?.options.map(option => option.label)).toEqual(['Inicio', 'folder/Ideas']);
  });
  it('does not offer note destinations in code, aliases or headings', () => {
    expect(complete('```md\n[[Ini')).toBeNull();
    expect(complete('`[[Ini`', 6)).toBeNull();
    expect(complete('[[Inicio|alias')).toBeNull();
    expect(complete('[[Inicio#Resumen')).toBeNull();
  });
  it('leaves out notes whose names cannot be written as a link (CR02)', () => {
    const context = new CompletionContext(EditorState.create({ doc: '[[', extensions: [markdown()] }), 2, false);
    expect(wikiCompletions(context, ['C.md', 'C# básico.md', 'a^b.md', 'x[1]/Nota.md', 'Normal.md'])?.options.map(option => option.label)).toEqual(['C', 'Normal']);
  });
  it('requires opening wiki brackets', () => {
    expect(complete('Plain note')).toBeNull();
  });
});

describe('heading navigation', () => {
  it('matches heading slugs and excludes code that looks like a heading', () => {
    const doc = '```md\n# Próximos pasos\n```\n\n## Próximos **pasos**\n';
    const state = EditorState.create({ doc, extensions: [markdown()] });
    expect(headingPosition(state, 'próximos-pasos')).toBe(doc.indexOf('## Próximos'));
  });
  it('finds setext headings and returns null for absent headings', () => {
    const state = EditorState.create({ doc: 'Intro\n\nDetalles\n--------\n', extensions: [markdown()] });
    expect(headingPosition(state, 'Detalles')).toBe(7);
    expect(headingPosition(state, 'Ausente')).toBeNull();
  });
});
