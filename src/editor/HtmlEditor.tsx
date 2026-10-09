import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Bold, Code, Heading1, Heading2, Heading3, Italic, List, ListChecks, ListOrdered, Minus, Quote, Redo2, SquareCode, Strikethrough, Table, Undo2 } from 'lucide-react';
import type { MarkdownEditorProps as NoteEditorProps } from './MarkdownEditor';
import { safeImageSource } from './livePreview';
import { headingKey, parseWikiLink, resolveWikiLink } from './wikilinks';
import { WikiLink, wikiLinkRefresh } from './htmlWikiLinks';
import { formatHtmlBlocks, joinHtmlDocument, splitHtmlDocument } from './htmlDocument';
import './editor.css';

/** HTML notes: a visual editor for the body, or CodeMirror over the whole file in source mode. */
export default function HtmlEditor(props: NoteEditorProps) {
  return props.sourceMode ? <HtmlSourceEditor {...props} /> : <RichHtmlEditor {...props} />;
}

function openLink(anchor: HTMLAnchorElement, onNavigate: (target: string) => void) {
  const wiki = anchor.dataset.wikilink;
  if (wiki !== undefined) { onNavigate(wiki); return; }
  const link = anchor.getAttribute('href') ?? '';
  if (/^(https?:|mailto:)/i.test(link)) void window.vault?.openExternal(link);
  else if (link && !/^[a-z][\w+.-]*:/i.test(link)) {
    let decoded = link;
    try { decoded = decodeURIComponent(link); } catch { /* Keep the original destination. */ }
    onNavigate(decoded);
  }
}

function RichHtmlEditor(props: NoteEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef<string | null>(null);
  // The file as loaded and its body as the schema normalizes it. Matching it again restores the exact original bytes.
  const pristine = useRef({ value: props.value, body: '' });
  const [, setRevision] = useState(0);

  useLayoutEffect(() => {
    if (!container.current) return;
    emitted.current = props.value;
    pristine.current = { value: props.value, body: '' };
    // Remote images and unsafe sources are only shown when allowed; the saved HTML keeps them unchanged.
    const SafeImage = Image.extend({
      addNodeView() {
        return ({ node }) => {
          const image = document.createElement('img');
          const source = String(node.attrs.src ?? '');
          if (safeImageSource(source) && !(latest.current.privateMode && /^https?:/i.test(source))) image.src = source;
          else image.className = 'is-blocked';
          image.alt = String(node.attrs.alt ?? '');
          if (node.attrs.title) image.title = String(node.attrs.title);
          return { dom: image };
        };
      },
    });
    const editor = new Editor({
      element: container.current,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'], HTMLAttributes: { rel: null, target: null } } }),
        TaskList, TaskItem.configure({ nested: true }),
        TableKit.configure({ table: { resizable: false } }),
        SafeImage.configure({ inline: false, allowBase64: true }),
        WikiLink.configure({
          resolve: target => resolveWikiLink(target, latest.current.notePath, latest.current.notePaths),
          notePaths: () => latest.current.notePaths,
        }),
      ],
      content: splitHtmlDocument(props.value).body,
      editorProps: {
        attributes: { class: 'html-content', 'aria-label': 'Contenido de la nota', spellcheck: 'true' },
        handleClick(view, _position, event) {
          const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
          if (!anchor || !view.dom.contains(anchor) || event.button !== 0) return false;
          event.preventDefault();
          openLink(anchor, latest.current.onNavigate);
          return true;
        },
      },
      onUpdate: ({ editor: current, transaction }) => {
        const body = formatHtmlBlocks(current.getHTML());
        // Schema fixes appended to a selection-only transaction (e.g. a trailing paragraph) are not edits.
        if (!transaction.docChanged && emitted.current === pristine.current.value) { pristine.current.body = body; return; }
        const next = body === pristine.current.body ? pristine.current.value : joinHtmlDocument(splitHtmlDocument(latest.current.value), body);
        if (next === emitted.current) return;
        emitted.current = next;
        latest.current.onChange(next);
      },
      onTransaction: () => setRevision(value => value + 1),
    });
    editorRef.current = editor;
    pristine.current.body = formatHtmlBlocks(editor.getHTML());
    editor.commands.focus('start');
    return () => {
      latest.current = { ...latest.current, onChange: () => {}, onNavigate: () => {} };
      editor.destroy(); editorRef.current = null;
    };
  }, [props.notePath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || props.value === emitted.current) return;
    // External change (reload, conflict resolution): replace without saving or adding history.
    emitted.current = props.value;
    editor.chain().setMeta('addToHistory', false).setContent(splitHtmlDocument(props.value).body, { emitUpdate: false }).run();
    pristine.current = { value: props.value, body: formatHtmlBlocks(editor.getHTML()) };
  }, [props.value, props.notePath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(wikiLinkRefresh, true));
  }, [props.notePaths, props.notePath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !props.focusHeading) return;
    const wanted = headingKey(parseWikiLink(`#${props.focusHeading}`).heading);
    let position: number | null = null;
    editor.state.doc.descendants((node, offset) => {
      if (position !== null) return false;
      if (node.type.name === 'heading' && headingKey(node.textContent) === wanted) position = offset + 1;
    });
    if (position !== null) editor.chain().focus().setTextSelection(position).scrollIntoView().run();
  }, [props.focusHeading, props.notePath, props.navigationId]);

  const editor = editorRef.current;
  const tool = (label: string, icon: ReactNode, run: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>, active?: string | [string, Record<string, unknown>]) => {
    const pressed = !!editor && active !== undefined && (typeof active === 'string' ? editor.isActive(active) : editor.isActive(active[0], active[1]));
    return <button type="button" className="icon-button" title={label} aria-label={label} aria-pressed={active === undefined ? undefined : pressed} disabled={!editor}
      onMouseDown={event => event.preventDefault()} onClick={() => { if (editor) run(editor.chain().focus()).run(); }}>{icon}</button>;
  };
  const inTable = !!editor?.isActive('table');
  return <div className="html-editor">
    <div className="html-toolbar" role="toolbar" aria-label="Formato">
      {tool('Negrita', <Bold size={15} />, chain => chain.toggleBold(), 'bold')}
      {tool('Cursiva', <Italic size={15} />, chain => chain.toggleItalic(), 'italic')}
      {tool('Tachado', <Strikethrough size={15} />, chain => chain.toggleStrike(), 'strike')}
      {tool('Código', <Code size={15} />, chain => chain.toggleCode(), 'code')}
      <span className="toolbar-separator" />
      {tool('Título 1', <Heading1 size={15} />, chain => chain.toggleHeading({ level: 1 }), ['heading', { level: 1 }])}
      {tool('Título 2', <Heading2 size={15} />, chain => chain.toggleHeading({ level: 2 }), ['heading', { level: 2 }])}
      {tool('Título 3', <Heading3 size={15} />, chain => chain.toggleHeading({ level: 3 }), ['heading', { level: 3 }])}
      <span className="toolbar-separator" />
      {tool('Lista', <List size={15} />, chain => chain.toggleBulletList(), 'bulletList')}
      {tool('Lista numerada', <ListOrdered size={15} />, chain => chain.toggleOrderedList(), 'orderedList')}
      {tool('Lista de tareas', <ListChecks size={15} />, chain => chain.toggleTaskList(), 'taskList')}
      {tool('Cita', <Quote size={15} />, chain => chain.toggleBlockquote(), 'blockquote')}
      {tool('Bloque de código', <SquareCode size={15} />, chain => chain.toggleCodeBlock(), 'codeBlock')}
      {tool('Separador', <Minus size={15} />, chain => chain.setHorizontalRule())}
      {tool('Insertar tabla', <Table size={15} />, chain => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
      {inTable && <span className="table-tools">
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().addRowAfter().run()}>+ fila</button>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().addColumnAfter().run()}>+ columna</button>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().deleteRow().run()}>− fila</button>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().deleteColumn().run()}>− columna</button>
        <button type="button" className="danger-text" onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().deleteTable().run()}>Quitar tabla</button>
      </span>}
      <span className="tool-spacer" />
      {tool('Deshacer', <Undo2 size={15} />, chain => chain.undo())}
      {tool('Rehacer', <Redo2 size={15} />, chain => chain.redo())}
    </div>
    <div className="html-scroll" ref={container} />
  </div>;
}

function HtmlSourceEditor(props: NoteEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const theme = useRef(new Compartment());

  useLayoutEffect(() => {
    if (!container.current) return;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({ doc: props.value, extensions: [
        history(), drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        html({ autoCloseTags: true }), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Código HTML de la nota', spellcheck: 'false' }),
        theme.current.of(EditorView.theme({}, { dark: props.theme === 'dark' })),
        EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
      ] }),
    });
    view.current = editor;
    editor.focus();
    return () => { latest.current = { ...latest.current, onChange: () => {} }; editor.destroy(); view.current = null; };
  }, [props.notePath]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== props.value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value }, annotations: Transaction.addToHistory.of(false) });
    }
  }, [props.value, props.notePath]);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(EditorView.theme({}, { dark: props.theme === 'dark' })) });
  }, [props.theme]);

  return <div className="markdown-editor is-source html-source" ref={container} />;
}
