import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Node } from '@tiptap/pm/model';
import { HtmlTextAlign, blockAlignment } from '../src/editor/htmlAlign';

// There is no DOM under vitest, so the schema is exercised directly; the commands themselves run in the e2e suite.
const schema = getSchema([StarterKit, TaskList, TaskItem, TableKit, HtmlTextAlign]);
const p = (text: string, textAlign: string | null = null) => schema.node('paragraph', { textAlign }, schema.text(text));

function renderStyle(node: Node): string | undefined {
  const [, attrs] = node.type.spec.toDOM!(node) as [string, Record<string, string>?, ...unknown[]];
  return attrs?.style;
}
function parsedAlign(name: string, textAlign: string): unknown {
  const rule = schema.nodes[name].spec.parseDOM!.find(candidate => candidate.tag === (name === 'paragraph' ? 'p' : 'h1'))!;
  return (rule.getAttrs as (element: unknown) => Record<string, unknown>)({ style: { textAlign }, getAttribute: () => null }).textAlign;
}
function stateAt(doc: Node, text: string) {
  let position = 0;
  doc.descendants((node, offset) => { if (node.isText && node.text === text) position = offset + 1; });
  return EditorState.create({ doc, selection: TextSelection.create(doc, position) });
}

describe('HTML text alignment', () => {
  it('serializes only explicit alignments, on paragraphs and headings', () => {
    expect(renderStyle(p('a'))).toBeUndefined();
    expect(renderStyle(p('a', 'center'))).toBe('text-align: center');
    expect(renderStyle(schema.node('heading', { level: 2, textAlign: 'right' }, schema.text('t')))).toBe('text-align: right');
    expect(renderStyle(p('a', 'justify'))).toBeUndefined();
  });

  it('reads supported alignments back from the markup and ignores the rest', () => {
    expect(parsedAlign('paragraph', 'right')).toBe('right');
    expect(parsedAlign('paragraph', 'left')).toBe('left');
    expect(parsedAlign('heading', 'center')).toBe('center');
    expect(parsedAlign('paragraph', 'justify')).toBeFalsy();
    expect(parsedAlign('paragraph', '')).toBeFalsy();
  });

  it('does not add the attribute to other blocks', () => {
    expect(schema.nodes.paragraph.spec.attrs ?? {}).toHaveProperty('textAlign');
    expect(schema.nodes.codeBlock.spec.attrs ?? {}).not.toHaveProperty('textAlign');
    expect(schema.nodes.blockquote.spec.attrs ?? {}).not.toHaveProperty('textAlign');
    expect(schema.nodes.listItem.spec.attrs ?? {}).not.toHaveProperty('textAlign');
  });

  it('reports the alignment of the block holding the cursor', () => {
    const doc = schema.node('doc', null, [p('uno', 'center'), p('dos'), schema.node('heading', { level: 1, textAlign: 'right' }, schema.text('tres')), p('cuatro', 'left')]);
    expect(blockAlignment(stateAt(doc, 'uno'))).toBe('center');
    expect(blockAlignment(stateAt(doc, 'dos'))).toBe('left');
    expect(blockAlignment(stateAt(doc, 'tres'))).toBe('right');
    expect(blockAlignment(stateAt(doc, 'cuatro'))).toBe('left');
  });

  it('finds paragraphs nested in lists, quotes and table cells', () => {
    const item = schema.node('listItem', null, p('lista', 'right'));
    const quote = schema.node('blockquote', null, p('cita', 'center'));
    const cell = schema.node('table', null, schema.node('tableRow', null, schema.node('tableCell', null, p('celda', 'right'))));
    const doc = schema.node('doc', null, [schema.node('bulletList', null, item), quote, cell, schema.node('codeBlock', null, schema.text('codigo'))]);
    expect(blockAlignment(stateAt(doc, 'lista'))).toBe('right');
    expect(blockAlignment(stateAt(doc, 'cita'))).toBe('center');
    expect(blockAlignment(stateAt(doc, 'celda'))).toBe('right');
    expect(blockAlignment(stateAt(doc, 'codigo'))).toBe('');
  });
});
