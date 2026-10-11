import TextAlign from '@tiptap/extension-text-align';
import type { EditorState } from '@tiptap/pm/state';

export type Alignment = 'left' | 'center' | 'right';
const BLOCKS = ['heading', 'paragraph'];

/** Per-block alignment. Left is the default, so "left" clears the attribute instead of writing a redundant style. */
export const HtmlTextAlign = TextAlign.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.unsetTextAlign(),
      'Mod-Shift-e': () => this.editor.commands.setTextAlign('center'),
      'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
    };
  },
}).configure({ types: BLOCKS, alignments: ['left', 'center', 'right'] });

/** Alignment of the block holding the selection start; empty when that is not a paragraph or heading. */
export function blockAlignment(state: EditorState): Alignment | '' {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (BLOCKS.includes(node.type.name)) return (node.attrs.textAlign as Alignment | null) || 'left';
  }
  return '';
}
