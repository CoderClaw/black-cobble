import { Facet, StateField, type EditorState, type Range } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { resolveWikiLink, wikiLinkLabelRange } from './wikilinks';

export interface PreviewOptions { sourceMode: boolean; notePath: string; notePaths: string[]; privateMode?: boolean }
export const previewOptions = Facet.define<PreviewOptions, PreviewOptions>({
  combine: values => values[0] ?? { sourceMode: false, notePath: '', notePaths: [] },
});

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super(); }
  eq(other: TextWidget) { return this.text === other.text && this.className === other.className; }
  toDOM() {
    const element = document.createElement('span');
    element.className = this.className;
    element.textContent = this.text;
    return element;
  }
}

export function safeImageSource(source: string): boolean {
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z\d+/=\s]+$/i.test(source)) return true;
  try { return ['https:', 'http:'].includes(new URL(source).protocol); } catch { return false; }
}

class ImageWidget extends WidgetType {
  constructor(readonly source: string, readonly alt: string) { super(); }
  eq(other: ImageWidget) { return this.source === other.source && this.alt === other.alt; }
  toDOM(view: EditorView) {
    const container = document.createElement('span');
    container.className = 'cm-md-image';
    const image = document.createElement('img');
    image.src = this.source;
    image.alt = this.alt;
    image.loading = 'lazy';
    image.addEventListener('load', () => view.requestMeasure());
    image.addEventListener('error', () => view.requestMeasure());
    container.append(image);
    return container;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(other: TaskWidget) { return this.checked === other.checked; }
  toDOM(view: EditorView) {
    const element = document.createElement('input');
    element.type = 'checkbox';
    element.checked = this.checked;
    element.className = 'cm-md-task';
    element.setAttribute('aria-label', this.checked ? 'Marcar tarea pendiente' : 'Completar tarea');
    element.addEventListener('mousedown', event => event.preventDefault());
    element.addEventListener('change', () => {
      // Locate the widget after edits above it, rather than retaining an old position.
      const position = view.posAtDOM(element);
      const line = view.state.doc.lineAt(position);
      const marker = /\[[ xX]\]/.exec(line.text);
      if (!marker) return;
      view.dispatch({ changes: { from: line.from + marker.index + 1, to: line.from + marker.index + 2, insert: element.checked ? 'x' : ' ' } });
    });
    return element;
  }
  ignoreEvent() { return true; }
}

export function isCodePosition(state: EditorState, position: number): boolean {
  const tree = ensureSyntaxTree(state, position, 20) ?? syntaxTree(state);
  for (let node = tree.resolveInner(position, -1); node; node = node.parent!) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return true;
    if (!node.parent) break;
  }
  return false;
}

export function buildPreview(state: EditorState): DecorationSet {
  const options = state.facet(previewOptions);
  if (options.sourceMode) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  const selected = state.selection.ranges.map(range => ({ from: state.doc.lineAt(range.from).from, to: state.doc.lineAt(range.to).to }));
  const active = (from: number, to: number) => selected.some(range => range.from <= to && range.to >= from);
  const lineMarks = new Set<string>();
  const line = (position: number, className: string) => {
    const from = state.doc.lineAt(position).from;
    const key = `${from}:${className}`;
    if (!lineMarks.has(key)) { lineMarks.add(key); decorations.push(Decoration.line({ class: className }).range(from)); }
  };
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (from < to) decorations.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const hide = (from: number, to: number) => {
    if (from < to && !active(from, to)) decorations.push(Decoration.replace({}).range(from, to));
  };
  const codeRanges: { from: number; to: number }[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 25) ?? syntaxTree(state);
  tree.iterate({ enter(node) {
    const { name, from, to } = node;
    const text = state.doc.sliceString(from, to);
    if (name === 'FencedCode' || name === 'CodeBlock') {
      codeRanges.push({ from, to });
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) line(state.doc.line(number).from, 'cm-md-code-line');
      if (name === 'FencedCode') {
        const first = state.doc.lineAt(from);
        hide(first.from, first.to);
        const last = state.doc.lineAt(to);
        if (last.number !== first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)) hide(last.from, last.to);
      }
      return false;
    }
    if (name === 'InlineCode') {
      codeRanges.push({ from, to });
      mark(from, to, 'cm-md-inline-code');
      const delimiter = /^`+/.exec(text)?.[0].length ?? 0;
      hide(from, from + delimiter);
      hide(to - delimiter, to);
      return false;
    }
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
    if (heading) line(from, `cm-md-heading cm-md-h${heading[1]}`);
    if (name === 'HeaderMark') {
      const after = state.doc.sliceString(to, Math.min(to + 1, state.doc.length));
      hide(from, to + (after === ' ' ? 1 : 0));
    }
    if (name === 'Emphasis') mark(from, to, 'cm-md-em');
    if (name === 'StrongEmphasis') mark(from, to, 'cm-md-strong');
    if (name === 'Strikethrough') mark(from, to, 'cm-md-strike');
    if (name === 'EmphasisMark' || name === 'StrikethroughMark') hide(from, to);
    if (name === 'Blockquote') {
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) line(state.doc.line(number).from, 'cm-md-quote');
    }
    if (name === 'QuoteMark') {
      hide(from, to + (state.doc.sliceString(to, to + 1) === ' ' ? 1 : 0));
    }
    if (name === 'ListItem') line(from, 'cm-md-list');
    if (name === 'ListMark' && !active(from, to) && /^[-+*]$/.test(text)) {
      decorations.push(Decoration.replace({ widget: new TextWidget('•', 'cm-md-bullet') }).range(from, to));
    }
    if (name === 'TaskMarker' && !active(from, to)) {
      decorations.push(Decoration.replace({ widget: new TaskWidget(/x/i.test(text)) }).range(from, to));
    }
    if (name === 'HorizontalRule' && !active(from, to)) {
      decorations.push(Decoration.replace({ widget: new TextWidget('', 'cm-md-rule') }).range(from, to));
      return false;
    }
    if (name === 'TableHeader' || name === 'TableRow') line(from, 'cm-md-table-row');
    if (name === 'TableHeader') line(from, 'cm-md-table-header');
    if (name === 'TableCell') mark(from, to, 'cm-md-table-cell');
    if (name === 'TableDelimiter') mark(from, to, 'cm-md-table-delimiter');
    if (name === 'Image') {
      const image = /^!\[([^\]]*)\]\(([^\s]+?)(?:\s+["'].*["'])?\)$/.exec(text);
      if (image && !active(from, to)) {
        const source = image[2].replace(/^<|>$/g, '');
        if (safeImageSource(source)) {
          if (options.privateMode && /^https?:/i.test(source)) {
            mark(from, to, 'cm-md-link', { 'data-link-target': source });
            if (image[1]) { hide(from, from + 2); hide(from + image[1].length + 2, to); }
          } else decorations.push(Decoration.replace({ widget: new ImageWidget(source, image[1]) }).range(from, to));
        }
      }
      return false;
    }
    if (name === 'Link') {
      // Wiki syntax is handled below because Markdown parses it as plain text.
      if (text.startsWith('[[')) return false;
      const inlineLink = /^\[([^\]]*)\]\(([^\s]+?)(?:\s+["'].*["'])?\)$/.exec(text);
      const autoLink = /^<(https?:\/\/[^>]+|mailto:[^>]+)>$/.exec(text);
      if (inlineLink) {
        const url = inlineLink[2].replace(/^<|>$/g, '');
        mark(from, to, 'cm-md-link', { 'data-link-target': url });
        if (!active(from, to)) { hide(from, from + 1); hide(from + inlineLink[1].length + 1, to); }
      } else if (autoLink) {
        mark(from, to, 'cm-md-link', { 'data-link-target': autoLink[1] });
        hide(from, from + 1); hide(to - 1, to);
      }
    }
  } });
  const wikiExpression = /\[\[([^\]\n]+)\]\]/g;
  const document = state.doc.toString();
  for (const match of document.matchAll(wikiExpression)) {
    const from = match.index;
    const to = from + match[0].length;
    if (to > tree.length) continue;
    if (codeRanges.some(range => range.from <= from && range.to >= from)) continue;
    // Markdown escapes must remain literal text.
    let slashes = 0;
    for (let position = from - 1; position >= 0 && document[position] === '\\'; position--) slashes++;
    if (slashes % 2) continue;
    const resolved = resolveWikiLink(match[1], options.notePath, options.notePaths);
    mark(from, to, `cm-wiki-link${resolved ? '' : ' cm-wiki-unresolved'}`, { 'data-wiki-target': match[1], title: resolved ?? 'Crear nota' });
    if (!active(from, to)) {
      const label = wikiLinkLabelRange(match[1]);
      hide(from, from + 2 + label.from);
      hide(from + 2 + label.to, to);
    }
  }
  return Decoration.set(decorations, true);
}

export const livePreview = StateField.define<DecorationSet>({
  create: buildPreview,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection || transaction.reconfigured || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ? buildPreview(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field),
});
