import { InputRule, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { linkTargetFor } from '../../shared/notes';
import { wikiLinkLabelRange } from './wikilinks';

export interface WikiLinkOptions {
  /** Read lazily so the editor never needs reconfiguring when notes change. */
  resolve: (target: string) => string | null;
  notePaths: () => string[];
  /** Target written for a chosen note, so it resolves to that note from the current one. */
  linkTarget: (path: string) => string;
}

export const wikiLinkRefresh = new PluginKey('wikiLinkRefresh');

const labelFor = (inner: string) => { const range = wikiLinkLabelRange(inner); return inner.slice(range.from, range.to); };

/** Popup rendered with plain DOM; text only, never markup from note names. */
function suggestionPopup() {
  let popup: HTMLDivElement | null = null;
  let current: SuggestionProps<string, string> | null = null;
  let selected = 0;
  const draw = () => {
    if (!popup || !current) return;
    popup.replaceChildren(...current.items.map((item, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = linkTargetFor(item);
      option.className = index === selected ? 'is-selected' : '';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === selected));
      option.addEventListener('mousedown', event => { event.preventDefault(); current?.command(item); });
      return option;
    }));
    popup.hidden = !current.items.length;
    const rect = current.clientRect?.();
    if (rect) { popup.style.left = `${rect.left}px`; popup.style.top = `${rect.bottom + 4}px`; }
    popup.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  };
  return {
    onStart(props: SuggestionProps<string, string>) {
      current = props; selected = 0;
      popup = document.createElement('div');
      popup.className = 'wiki-suggest';
      popup.setAttribute('role', 'listbox');
      popup.setAttribute('aria-label', 'Notas para enlazar');
      document.body.append(popup);
      draw();
    },
    onUpdate(props: SuggestionProps<string, string>) { current = props; selected = Math.min(selected, Math.max(0, props.items.length - 1)); draw(); },
    onKeyDown({ event }: { event: KeyboardEvent }) {
      const count = current?.items.length ?? 0;
      if (!count) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
        draw(); return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') { current!.command(current!.items[selected]); return true; }
      return false;
    },
    onExit() { popup?.remove(); popup = null; current = null; },
  };
}

/** Stored as <a class="wikilink" data-wikilink="Ruta#Encabezado">alias</a>. */
export const WikiLink = Mark.create<WikiLinkOptions>({
  name: 'wikilink',
  priority: 1100,
  inclusive: false,
  excludes: 'link code',
  addOptions() { return { resolve: () => null, notePaths: () => [], linkTarget: linkTargetFor }; },
  addAttributes() {
    return { target: { default: '', parseHTML: element => element.getAttribute('data-wikilink') ?? '', renderHTML: attributes => ({ 'data-wikilink': attributes.target }) } };
  },
  parseHTML() { return [{ tag: 'a[data-wikilink]' }]; },
  renderHTML({ HTMLAttributes }) { return ['a', mergeAttributes({ class: 'wikilink' }, HTMLAttributes), 0]; },
  addInputRules() {
    const type = this.type;
    return [new InputRule({
      // Typing [[Nota#Parte|alias]] by hand converts it into a link.
      find: /\[\[([^[\]\n]+)\]\]$/,
      handler: ({ state, range, match }) => {
        const inner = match[1];
        const pipe = inner.indexOf('|');
        const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
        const label = labelFor(inner);
        if (!target || !label) return null;
        state.tr.replaceWith(range.from, range.to, state.schema.text(label, [type.create({ target })]));
      },
    })];
  },
  addProseMirrorPlugins() {
    const { resolve, notePaths, linkTarget } = this.options;
    const type = this.type;
    const editor = this.editor;
    return [
      new Plugin({
        key: wikiLinkRefresh,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              const mark = node.isText ? node.marks.find(item => item.type === type) : undefined;
              if (!mark) return;
              const resolved = resolve(mark.attrs.target);
              decorations.push(Decoration.inline(position, position + node.nodeSize, { class: resolved ? '' : 'is-unresolved', title: resolved ?? 'Crear nota' }));
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
      Suggestion<string, string>({
        editor,
        pluginKey: new PluginKey('wikiLinkSuggestion'),
        char: '[[',
        findSuggestionMatch: ({ $position }) => {
          const parent = $position.parent;
          if (!parent.isTextblock || parent.type.spec.code) return null;
          const before = parent.textBetween(0, $position.parentOffset, undefined, '￼');
          const match = /\[\[([^[\]\n|#]*)$/.exec(before);
          if (!match) return null;
          return { range: { from: $position.pos - match[0].length, to: $position.pos }, query: match[1], text: match[0] };
        },
        allow: ({ state, range }) => !state.doc.resolve(range.from).marks().some(mark => mark.type.name === 'code'),
        items: ({ query }) => {
          const wanted = query.trim().toLocaleLowerCase();
          return [...notePaths()].sort().filter(path => linkTargetFor(path).toLocaleLowerCase().includes(wanted)).slice(0, 50);
        },
        command: ({ editor: target, range, props: path }) => {
          const link = linkTarget(path);
          target.chain().focus().insertContentAt(range, [
            { type: 'text', text: labelFor(link), marks: [{ type: 'wikilink', attrs: { target: link } }] },
            { type: 'text', text: ' ' },
          ]).run();
        },
        render: suggestionPopup,
      }),
    ];
  },
});
