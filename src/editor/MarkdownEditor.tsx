import { useEffect, useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { tags } from '@lezer/highlight';
import { syntaxHighlighting, HighlightStyle, indentOnInput, ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { autocompletion, closeCompletion, completionKeymap, type CompletionContext, type Completion } from '@codemirror/autocomplete';
import { isCodePosition, livePreview, previewOptions } from './livePreview';
import { headingKey, parseWikiLink } from './wikilinks';
import { linkTargetFor } from '../../shared/notes';
import './editor.css';

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  notePath: string;
  notePaths: string[];
  onNavigate: (target: string) => void;
  sourceMode: boolean;
  privateMode?: boolean;
  theme: 'dark' | 'light';
  focusHeading?: string;
  navigationId?: number;
}

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-syntax-heading', fontWeight: '650' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, Consolas, monospace' },
  { tag: [tags.processingInstruction, tags.meta, tags.comment, tags.contentSeparator, tags.labelName], color: 'var(--muted)' },
  { tag: tags.url, color: 'var(--accent)' },
]);

export function wikiCompletions(context: CompletionContext, paths: string[]) {
  if (isCodePosition(context.state, context.pos)) return null;
  const match = context.matchBefore(/\[\[[^\]\n]*/);
  if (!match || /[|#]/.test(match.text)) return null;
  const options: Completion[] = [...paths].sort().map(path => {
    // HTML targets keep .html: Obsidian only resolves bare names to Markdown notes.
    const target = linkTargetFor(path);
    return {
      label: target,
      type: 'text',
      apply(view, _completion, from, to) {
        const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0;
        view.dispatch({ changes: { from, to: to + suffix, insert: `${target}]]` }, selection: { anchor: from + target.length + 2 } });
      },
    };
  });
  return { from: match.from + 2, options, validFor: /^[^\]\n|#]*$/ };
}

export function headingPosition(state: EditorState, heading: string): number | null {
  const wanted = headingKey(heading);
  let position: number | null = null;
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({ enter(node) {
    if (position !== null || !/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) return;
    const line = state.doc.lineAt(node.from);
    const title = node.name.startsWith('ATX') ? line.text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '') : line.text;
    if (headingKey(title) === wanted) position = line.from;
  } });
  return position;
}

export default function MarkdownEditor(props: MarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const options = useRef(new Compartment());
  const theme = useRef(new Compartment());

  useLayoutEffect(() => {
    if (!container.current) return;
    const current = props;
    latest.current = props;
    const extensionsFor = (configuration: MarkdownEditorProps): Extension[] => [
          history(), drawSelection(), dropCursor(), highlightActiveLine(), indentOnInput(),
          keymap.of([...completionKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ extensions: GFM }), syntaxHighlighting(markdownHighlightStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Contenido de la nota', spellcheck: 'true' }),
          options.current.of(previewOptions.of({ sourceMode: configuration.sourceMode, notePath: configuration.notePath, notePaths: configuration.notePaths, privateMode: configuration.privateMode })),
          theme.current.of(EditorView.theme({}, { dark: configuration.theme === 'dark' })),
          livePreview,
          autocompletion({ override: [context => wikiCompletions(context, latest.current.notePaths)] }),
          EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
          EditorView.domEventHandlers({
            mousedown(event, editorView) {
              if (event.button !== 0) return false;
              const target = (event.target as HTMLElement).closest<HTMLElement>('[data-wiki-target], [data-link-target]');
              if (!target) return false;
              const position = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
              const activeLine = position !== null && editorView.state.selection.ranges.some(range => {
                const from = editorView.state.doc.lineAt(range.from).from;
                const to = editorView.state.doc.lineAt(range.to).to;
                return from <= position && to >= position;
              });
              if (activeLine && !event.ctrlKey && !event.metaKey) return false;
              event.preventDefault();
              const wiki = target.dataset.wikiTarget;
              if (wiki !== undefined) latest.current.onNavigate(wiki);
              else {
                const link = target.dataset.linkTarget ?? '';
                if (/^(https?:|mailto:)/i.test(link)) void window.vault?.openExternal(link);
                else if (link && !/^[a-z][\w+.-]*:/i.test(link)) {
                  let decoded = link;
                  try { decoded = decodeURIComponent(link); } catch { /* Keep the original destination. */ }
                  latest.current.onNavigate(decoded);
                }
              }
              return true;
            },
          }),
    ];
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({ doc: current.value, extensions: extensionsFor(current) }),
    });
    view.current = editor;
    editor.focus();
    return () => {
      latest.current = { ...latest.current, value: '', notePath: '', notePaths: [], focusHeading: undefined, onChange: () => {}, onNavigate: () => {} };
      closeCompletion(editor);
      // Deferred completion callbacks still need their fields after destruction.
      // Recreate those fields with an empty document, history and note list.
      editor.setState(EditorState.create({ doc: '', extensions: extensionsFor(latest.current) }));
      editor.destroy(); view.current = null;
    };
  }, [props.notePath]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== props.value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value }, annotations: Transaction.addToHistory.of(false) });
    }
  }, [props.value, props.notePath]);

  useEffect(() => {
    view.current?.dispatch({ effects: [
      options.current.reconfigure(previewOptions.of({ sourceMode: props.sourceMode, notePath: props.notePath, notePaths: props.notePaths, privateMode: props.privateMode })),
      theme.current.reconfigure(EditorView.theme({}, { dark: props.theme === 'dark' })),
    ] });
  }, [props.sourceMode, props.theme, props.notePath, props.notePaths, props.privateMode]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !props.focusHeading) return;
    const position = headingPosition(editor.state, parseWikiLink(`#${props.focusHeading}`).heading);
    if (position !== null) {
      editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 28 }) });
      editor.focus();
    }
  }, [props.focusHeading, props.notePath, props.navigationId]);

  return <div className={`markdown-editor${props.sourceMode ? ' is-source' : ''}`} ref={container} />;
}
