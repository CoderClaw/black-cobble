import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Ellipsis, FileCode2, FileText, ListX, RefreshCw, Regex, Replace, ReplaceAll, WholeWord, X } from 'lucide-react';
import { expandReplacement, searchPattern, type ReplaceEdit, type ReplaceOutcome, type ReplaceTarget, type SearchFileResult, type SearchMatch, type SearchOptions, type SearchResult } from '../../shared/search';
import { noteFormat } from '../../shared/notes';
import { useModalDialog } from './useModalDialog';
import { baseName, errorMessage, parentPath } from '../lib/paths';

export interface SearchRequest { id: number; mode: 'search' | 'replace'; seed?: string }
interface Props {
  open: boolean;
  locked: boolean;
  canEdit: boolean;
  busy: boolean;
  /** Increments whenever the vault changed on disk. */
  revision: number;
  request: SearchRequest;
  onSearch: (options: SearchOptions, save: boolean) => Promise<SearchResult>;
  /** 'stale' when the open note changed since the search, so nothing was sent. */
  onReplace: (options: SearchOptions, replacement: string, targets: ReplaceTarget[]) => Promise<ReplaceOutcome[] | 'stale' | null>;
  /** `ordinal`: earlier matches in the file with the same text, for editors that cannot use raw offsets. */
  onOpenMatch: (path: string, match: SearchMatch, version: string, ordinal: number, options: SearchOptions) => void;
  onEscape: () => void;
  onClose: () => void;
}
type Shown = SearchResult & { options: SearchOptions };
interface Range { start: number; end: number }
/** Dismissed matches of one file, valid for that exact version only; `prior` covers results from before a replace. */
interface Dismissed { version: string; ranges: Range[]; prior?: { version: string; ranges: Range[] } }
interface Item { path: string; key: string; ordinal: number; match: SearchMatch }
interface Entry { file: SearchFileResult; items: Item[] }
interface RowActions { open: (item: Item) => void; replace: (item: Item, element: HTMLElement) => void; dismiss: (item: Item, element: HTMLElement) => void }
interface Confirmation { message: string; options: SearchOptions; replacement: string; entries: Entry[] }

const ROW_BUDGET = 500;
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const rangesFor = (dismissed: Dismissed | undefined, version: string) => dismissed?.version === version ? dismissed.ranges : dismissed?.prior?.version === version ? dismissed.prior.ranges : undefined;
/** Move ranges through a rewrite; a range touched by an edit is gone. */
function mapRanges(ranges: Range[], edits: ReplaceEdit[]): Range[] {
  return ranges.flatMap(range => {
    let delta = 0;
    for (const edit of edits) {
      if (edit.start < range.end && edit.end > range.start) return [];
      if (edit.end <= range.start) delta += edit.length - (edit.end - edit.start);
    }
    return [{ start: range.start + delta, end: range.end + delta }];
  });
}
const clipStart = (text: string) => { const chars = Array.from(text.trimStart()); return chars.length > 28 ? `…${chars.slice(-27).join('')}` : chars.join(''); };
const sameOptions = (a: SearchOptions, b: SearchOptions) => a.query === b.query && a.matchCase === b.matchCase && a.wholeWord === b.wholeWord && a.regex === b.regex && (a.include ?? '') === (b.include ?? '') && (a.exclude ?? '') === (b.exclude ?? '');
/** The logical letter, or the physical one when the layout or Option produces something else. */
export const letterKey = (event: { key: string; code: string }) => /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : '';

/** Sticky version of the search pattern, so a preview can match at the hit inside its line context. */
function previewPattern(options: SearchOptions): RegExp | null {
  if (!options.regex) return null;
  try { const pattern = searchPattern(options); return pattern && new RegExp(pattern.source, `${pattern.flags.replace('g', '')}y`); }
  catch { return null; }
}
/** Display-only text a match becomes, or undefined when it cannot be shown faithfully. The main process does the real replacement. */
function replacementFor(match: SearchMatch, options: SearchOptions, sticky: RegExp | null, replacement: string): string | undefined {
  if (!options.regex) return replacement;
  if (!sticky) return undefined;
  const { before, text, after } = match.preview;
  sticky.lastIndex = before.length;
  const found = sticky.exec(before + text + after);
  return found?.[0] === text ? expandReplacement(replacement, found) : undefined;
}

function replaceSummary(outcomes: ReplaceOutcome[]): string {
  const replaced = outcomes.filter(outcome => outcome.status === 'replaced' && outcome.count > 0);
  const count = replaced.reduce((total, outcome) => total + outcome.count, 0);
  const conflicts = outcomes.filter(outcome => outcome.status === 'conflict').length;
  const errors = outcomes.filter(outcome => outcome.status === 'error');
  const parts = [count ? `Se ${count === 1 ? 'reemplazó' : 'reemplazaron'} ${plural(count, 'coincidencia', 'coincidencias')} en ${plural(replaced.length, 'archivo', 'archivos')}.` : 'No se reemplazó ninguna coincidencia.'];
  if (conflicts) parts.push(conflicts === 1 ? '1 archivo cambió y no se modificó.' : `${conflicts} archivos cambiaron y no se modificaron.`);
  if (errors.length) parts.push(errors.length === 1 ? `1 archivo no se pudo modificar${errors[0].message ? `: ${errors[0].message}` : '.'}` : `${errors.length} archivos no se pudieron modificar.`);
  return parts.join(' ');
}

function ConfirmReplace({ message, onCancel, onConfirm, fallbackFocus }: { message: string; onCancel: () => void; onConfirm: () => void; fallbackFocus: () => HTMLElement | null }) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // While replacing, the Reemplazar todo button that opened this is disabled and cannot take focus back.
  useModalDialog(element, { fallback: fallbackFocus });
  return <dialog ref={element} className="entry-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); onConfirm(); }}>
      <h2 id={titleId}>Reemplazar todo</h2>
      <p id={descriptionId}>{message}</p>
      <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancelar</button><button type="submit" className="primary-button">Reemplazar</button></div>
    </form>
  </dialog>;
}

const MatchRow = memo(function MatchRow({ item, diff, showReplace, canReplace, actions }: { item: Item; diff?: string; showReplace: boolean; canReplace: boolean; actions: RowActions }) {
  const { match } = item;
  return <li className="search-row search-match-row">
    <button className="search-row-main" title={`Línea ${match.line + 1}`} aria-label={diff === undefined ? undefined : `${match.preview.text} → ${diff}, línea ${match.line + 1}`} onClick={() => actions.open(item)}>
      <span className="search-preview">{clipStart(match.preview.before)}{diff !== undefined ? <><del className="search-replace-old">{match.preview.text}</del><ins className="search-replace-new">{diff}</ins></> : <mark>{match.preview.text}</mark>}{match.preview.after}</span>
    </button>
    <span className="search-row-actions">
      {showReplace && <button className="icon-button" aria-label="Reemplazar" title="Reemplazar" disabled={!canReplace} onClick={event => actions.replace(item, event.currentTarget)}><Replace size={14} /></button>}
      <button className="icon-button" aria-label="Descartar" title="Descartar" onClick={event => actions.dismiss(item, event.currentTarget)}><X size={14} /></button>
    </span>
  </li>;
});

export default function SearchPanel(props: Props) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [replaceVisible, setReplaceVisible] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [result, setResult] = useState<Shown | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState('');
  const [dismissedFiles, setDismissedFiles] = useState<Set<string>>(new Set());
  const [dismissedMatches, setDismissedMatches] = useState<Map<string, Dismissed>>(new Map());
  const [notice, setNotice] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rowLimit, setRowLimit] = useState(ROW_BUDGET);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<'search' | 'replace' | null>(null);
  const pendingRow = useRef<number | null>(null);
  const handledRequest = useRef(props.request.id);
  const seenRevision = useRef(props.revision);
  const generation = useRef(0);
  const staleRetries = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(props);
  latest.current = props;

  const options = useMemo<SearchOptions>(() => ({ query, matchCase, wholeWord, regex, include: include.trim() || undefined, exclude: exclude.trim() || undefined }), [query, matchCase, wholeWord, regex, include, exclude]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const run = useCallback(async (save: boolean) => {
    if (!mounted.current) return;
    const id = ++generation.current;
    const current = optionsRef.current;
    if (!current.query || latest.current.locked) { setResult(null); setError(''); setSearching(false); return; }
    setSearching(true);
    let retrying = false;
    try {
      const found = await latest.current.onSearch(current, save);
      if (id !== generation.current) return;
      staleRetries.current = 0;
      setResult({ ...found, options: current }); setError('');
    } catch (reason) {
      if (id !== generation.current) return;
      // A response discarded because the vault or session moved on is retried, never left as a blank panel.
      if (errorMessage(reason).startsWith('PRIVATE_STALE:') && staleRetries.current++ < 3) {
        retrying = true;
        setTimeout(() => { if (id === generation.current) void run(save); }, 300);
        return;
      }
      staleRetries.current = 0;
      setResult(null); setError(errorMessage(reason).startsWith('PRIVATE_STALE:') ? 'No se ha podido buscar porque la bóveda cambió. Pulsa Actualizar.' : errorMessage(reason));
    } finally { if (id === generation.current && !retrying) setSearching(false); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);

  useEffect(() => {
    setDismissedFiles(new Set()); setDismissedMatches(new Map()); setStatus(''); setNotice(''); setRowLimit(ROW_BUDGET);
    if (!options.query) { ++generation.current; setResult(null); setError(''); setSearching(false); return; }
    const timer = setTimeout(() => { void run(true); }, 250);
    return () => clearTimeout(timer);
  }, [options, run]);

  // Reopening refreshes at once; disk changes (autosaves included) are batched.
  useEffect(() => { if (props.open && optionsRef.current.query) void run(false); }, [props.open, run]);
  useEffect(() => {
    if (props.revision === seenRevision.current) return;
    seenRevision.current = props.revision;
    if (!props.open || !optionsRef.current.query) return;
    const timer = setTimeout(() => { void run(false); }, 1000);
    return () => clearTimeout(timer);
  }, [props.revision, props.open, run]);

  // Layout effects: the shortcut's focus lands within its own event, never after the user moved on.
  useLayoutEffect(() => {
    if (props.request.id === handledRequest.current) return;
    handledRequest.current = props.request.id;
    if (props.request.seed) setQuery(props.request.seed);
    if (props.request.mode === 'replace') setReplaceVisible(true);
    pendingFocus.current = props.request.mode;
  }, [props.request]);
  useLayoutEffect(() => {
    const target = pendingFocus.current === 'replace' ? replaceInput.current : pendingFocus.current === 'search' ? searchInput.current : null;
    if (target) { pendingFocus.current = null; target.focus(); target.select(); }
  });
  useEffect(() => {
    // After a dismissal or a replacement, focus stays at the same place in the list.
    if (pendingRow.current !== null && !searching && !replacing && !props.busy && list.current) {
      const rows = list.current.querySelectorAll<HTMLElement>('.search-row-main');
      (rows[Math.min(pendingRow.current, rows.length - 1)] ?? list.current).focus();
      pendingRow.current = null;
    }
  });

  const entries = useMemo<Entry[]>(() => (result?.files ?? []).map(file => {
    const counts = new Map<string, number>();
    return { file, items: file.matches.map(match => {
      const ordinal = counts.get(match.preview.text) ?? 0;
      counts.set(match.preview.text, ordinal + 1);
      return { path: file.path, key: `${match.start}:${match.end}`, ordinal, match };
    }) };
  }), [result]);
  // Offsets cannot follow a change made elsewhere: such a file's dismissals are dropped, visibly, rather than guessed.
  useEffect(() => {
    if (!result) return;
    const changed: string[] = [];
    setDismissedMatches(previous => {
      if (!previous.size) return previous;
      const next = new Map(previous);
      for (const file of result.files) {
        const dismissed = next.get(file.path);
        if (!dismissed) continue;
        if (dismissed.version === file.version) { if (dismissed.prior) next.set(file.path, { version: dismissed.version, ranges: dismissed.ranges }); }
        else if (dismissed.prior?.version !== file.version) { next.delete(file.path); changed.push(file.path); }
      }
      return next;
    });
    if (changed.length) setNotice(changed.length === 1 ? `${baseName(changed[0])} cambió: vuelven a mostrarse sus coincidencias descartadas.` : `${changed.length} archivos cambiaron: vuelven a mostrarse sus coincidencias descartadas.`);
  }, [result]);
  const visible = useMemo(() => entries
    .filter(entry => !dismissedFiles.has(entry.file.path))
    .map(entry => {
      const ranges = rangesFor(dismissedMatches.get(entry.file.path), entry.file.version);
      return ranges ? { file: entry.file, items: entry.items.filter(item => !ranges.some(range => range.start === item.match.start && range.end === item.match.end)) } : entry;
    })
    .filter(entry => entry.items.length > 0), [entries, dismissedFiles, dismissedMatches]);
  const total = visible.reduce((count, entry) => count + entry.items.length, 0);
  const allCollapsed = visible.length > 0 && visible.every(entry => collapsed.has(entry.file.path));
  // Results for other options than the inputs show must never be replaced.
  const stale = searching || !result || !sameOptions(result.options, options);
  const canReplace = props.canEdit && !stale && !replacing;
  const sticky = useMemo(() => result && previewPattern(result.options), [result]);
  const diffFor = (item: Item) => replaceVisible && replacement !== '' && result ? replacementFor(item.match, result.options, sticky, replacement) : undefined;

  async function replace(groups: Entry[], searchOptions: SearchOptions, text: string) {
    if (!groups.length || !latest.current.canEdit) return;
    // Anything dismissed in a file (or not loaded) is protected by naming the exact ranges.
    const targets = groups.map(({ file, items }): ReplaceTarget => items.length === file.matches.length && !result?.truncated
      ? { path: file.path, version: file.version }
      : { path: file.path, version: file.version, matches: items.map(item => ({ start: item.match.start, end: item.match.end })) });
    setReplacing(true);
    try {
      const outcomes = await latest.current.onReplace(searchOptions, text, targets);
      if (!mounted.current) return;
      if (outcomes === 'stale') setStatus('La nota abierta cambió después de buscar; los resultados se han actualizado. Vuelve a reemplazar.');
      else if (outcomes) {
        setStatus(replaceSummary(outcomes));
        // Dismissed ranges follow the exact rewrites; without them a file's dismissals are dropped, never guessed.
        setDismissedMatches(previous => {
          if (!previous.size) return previous;
          const next = new Map(previous);
          for (const outcome of outcomes) {
            const dismissed = next.get(outcome.path);
            if (!dismissed || outcome.status !== 'replaced' || !outcome.count) continue;
            const { edits } = outcome;
            const sent = targets.find(target => target.path === outcome.path);
            if (edits && outcome.version && sent?.version === dismissed.version) next.set(outcome.path, { version: outcome.version, ranges: mapRanges(dismissed.ranges, edits), prior: { version: dismissed.version, ranges: dismissed.ranges } });
            else next.delete(outcome.path);
          }
          return next;
        });
      }
    } finally { if (mounted.current) setReplacing(false); }
    await run(false);
  }
  function askReplaceAll() {
    if (!result || !total || !canReplace) return;
    const shown = replacement ? `por «${replacement}»` : 'por un texto vacío';
    setConfirm({
      message: `¿Reemplazar ${plural(total, 'coincidencia', 'coincidencias')} en ${plural(visible.length, 'archivo', 'archivos')} ${shown}?${result.truncated ? ' Solo se reemplazarán las coincidencias mostradas; la búsqueda tiene más.' : ''}`,
      options: result.options, replacement, entries: visible,
    });
  }
  function rowIndex(element: HTMLElement) {
    const row = element.closest('.search-row')?.querySelector('.search-row-main');
    return row && list.current ? [...list.current.querySelectorAll('.search-row-main')].indexOf(row) : -1;
  }
  function toggleFile(path: string) { setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  function clearResults() { ++generation.current; setQuery(''); setResult(null); setError(''); setStatus(''); setSearching(false); setCollapsed(new Set()); searchInput.current?.focus(); }

  const handlers = useRef<RowActions>(null!);
  handlers.current = {
    open: item => { if (result) props.onOpenMatch(item.path, item.match, result.files.find(file => file.path === item.path)?.version ?? '', item.ordinal, result.options); },
    replace: (item, element) => {
      const entry = visible.find(candidate => candidate.file.path === item.path);
      if (!entry || !result || !canReplace) return;
      pendingRow.current = rowIndex(element);
      void replace([{ file: entry.file, items: [item] }], result.options, replacement);
    },
    dismiss: (item, element) => {
      const version = result?.files.find(file => file.path === item.path)?.version;
      if (version === undefined) return;
      pendingRow.current = rowIndex(element);
      setDismissedMatches(previous => {
        const current = previous.get(item.path);
        const ranges = current?.version === version ? current.ranges : [];
        return new Map(previous).set(item.path, { version, ranges: [...ranges, { start: item.match.start, end: item.match.end }] });
      });
    },
  };
  const actions = useMemo<RowActions>(() => ({ open: item => handlers.current.open(item), replace: (item, element) => handlers.current.replace(item, element), dismiss: (item, element) => handlers.current.dismiss(item, element) }), []);

  function keydown(event: KeyboardEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('dialog')) return;
    if (event.key === 'Escape') { event.preventDefault(); props.onEscape(); return; }
    // Alt+C/W/R like VS Code; on macOS Cmd+Option, so Option keeps typing characters.
    if (isMac ? !(event.metaKey && event.altKey) || event.ctrlKey : !event.altKey || event.ctrlKey || event.metaKey) return;
    const toggle = ({ c: setMatchCase, w: setWholeWord, r: setRegex } as Record<string, typeof setRegex | undefined>)[letterKey(event)];
    if (toggle) { event.preventDefault(); toggle(value => !value); }
  }
  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('.search-row-main')];
    const index = rows.findIndex(row => row === document.activeElement || row.parentElement?.contains(document.activeElement));
    const next = rows[index === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { event.preventDefault(); next.focus(); }
  }

  const shortcut = (letter: string) => isMac ? `⌥⌘${letter}` : `Alt+${letter}`;
  const option = (label: string, letter: string, icon: ReactNode, pressed: boolean, set: (value: boolean) => void) =>
    <button type="button" className="search-option" aria-label={label} title={`${label} (${shortcut(letter)})`} aria-pressed={pressed} onClick={() => set(!pressed)}>{icon}</button>;
  const summary = !query || error ? '' : !result ? searching ? 'Buscando…' : '' : total === 0 ? 'Sin resultados.' : `${plural(total, 'resultado', 'resultados')} en ${plural(visible.length, 'archivo', 'archivos')}`;

  // A row budget keeps huge result sets responsive; "Mostrar más" raises it.
  let budget = rowLimit;
  let more = false;
  const rows: ReactNode[] = [];
  for (const entry of visible) {
    if (budget <= 0) { more = true; break; }
    const { file, items } = entry;
    const open = !collapsed.has(file.path);
    const shown = open ? items.slice(0, budget - 1) : [];
    budget -= 1 + shown.length;
    if (shown.length < (open ? items.length : 0)) more = true;
    const Icon = noteFormat(file.path) === 'html' ? FileCode2 : FileText;
    rows.push(<li key={file.path}>
      <div className="search-row search-file-row">
        <button className="search-row-main" title={file.path} aria-expanded={open} onClick={() => toggleFile(file.path)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Icon size={14} /><span className="search-file-name">{baseName(file.path)}</span><span className="search-file-folder">{parentPath(file.path)}</span><span className="search-count" aria-label={plural(items.length, 'resultado', 'resultados')}>{items.length}</span>
        </button>
        <span className="search-row-actions">
          {replaceVisible && <button className="icon-button" aria-label="Reemplazar todo en el archivo" title="Reemplazar todo en el archivo" disabled={!canReplace} onClick={event => { if (!result) return; pendingRow.current = rowIndex(event.currentTarget); void replace([entry], result.options, replacement); }}><ReplaceAll size={14} /></button>}
          <button className="icon-button" aria-label="Descartar" title="Descartar" onClick={event => { pendingRow.current = rowIndex(event.currentTarget); setDismissedFiles(previous => new Set(previous).add(file.path)); }}><X size={14} /></button>
        </span>
      </div>
      {shown.length > 0 && <ul>{shown.map(item => <MatchRow key={item.key} item={item} diff={diffFor(item)} showReplace={replaceVisible} canReplace={canReplace} actions={actions} />)}</ul>}
    </li>);
    if (shown.length < (open ? items.length : 0)) break;
  }

  return <aside className="search-panel" aria-label="Buscar en notas" hidden={!props.open} onKeyDown={keydown}>
    <header className="search-header">
      <h2>Buscar</h2>
      <div className="search-header-actions">
        <button className="icon-button" aria-label="Actualizar" title="Actualizar" disabled={props.locked || !query} onClick={() => void run(true)}><RefreshCw size={15} /></button>
        <button className="icon-button" aria-label="Borrar resultados" title="Borrar resultados" disabled={props.locked || (!query && !result)} onClick={clearResults}><ListX size={15} /></button>
        <button className="icon-button" aria-label={allCollapsed ? 'Expandir todo' : 'Contraer todo'} title={allCollapsed ? 'Expandir todo' : 'Contraer todo'} disabled={!visible.length} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(visible.map(entry => entry.file.path)))}>{allCollapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}</button>
        <button className="icon-button" aria-label="Cerrar búsqueda" title="Cerrar búsqueda" onClick={props.onClose}><X size={15} /></button>
      </div>
    </header>
    {props.locked ? <p className="search-empty">Desbloquea la bóveda privada para buscar en sus notas.</p> : <>
      <div className="search-form">
        <button type="button" className="search-replace-toggle" aria-label="Alternar reemplazo" title="Alternar reemplazo" aria-expanded={replaceVisible} onClick={() => setReplaceVisible(!replaceVisible)}>{replaceVisible ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <div className="search-form-rows">
          <div className={`search-box ${error ? 'invalid' : ''}`}>
            <input ref={searchInput} aria-label="Buscar" placeholder="Buscar" value={query} spellCheck={false} aria-invalid={!!error} aria-describedby="search-error"
              onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void run(true); } }} />
            {option('Coincidir mayúsculas y minúsculas', 'C', <CaseSensitive size={16} />, matchCase, setMatchCase)}
            {option('Solo palabras completas', 'W', <WholeWord size={16} />, wholeWord, setWholeWord)}
            {option('Usar expresión regular', 'R', <Regex size={15} />, regex, setRegex)}
          </div>
          <p className="search-error" id="search-error" aria-live="polite">{error}</p>
          {replaceVisible && <div className="search-replace-row">
            <div className="search-box"><input ref={replaceInput} aria-label="Reemplazar" placeholder="Reemplazar" value={replacement} spellCheck={false} onChange={event => setReplacement(event.target.value)} /></div>
            <button type="button" className="icon-button" aria-label="Reemplazar todo" title="Reemplazar todo" disabled={!canReplace || !total} onClick={askReplaceAll}><ReplaceAll size={16} /></button>
          </div>}
        </div>
      </div>
      <div className="search-details-toggle"><button type="button" className={`icon-button ${include || exclude ? 'has-filters' : ''}`} aria-label="Alternar detalles de búsqueda" title="Alternar detalles de búsqueda" aria-expanded={detailsVisible} onClick={() => setDetailsVisible(!detailsVisible)}><Ellipsis size={15} /></button></div>
      {detailsVisible && <div className="search-details">
        <label>Archivos para incluir<input value={include} placeholder="p. ej. Proyectos, *.md" spellCheck={false} onChange={event => setInclude(event.target.value)} /></label>
        <label>Archivos para excluir<input value={exclude} placeholder="p. ej. Archivo, *.html" spellCheck={false} onChange={event => setExclude(event.target.value)} /></label>
      </div>}
      <p className="search-summary" aria-live="polite">{summary}</p>
      {result?.truncated && <p className="search-notice">Hay más resultados de los que se muestran. Acota la búsqueda.</p>}
      {status && <p className="search-notice" role="status">{status}</p>}
      {notice && <p className="search-notice">{notice}</p>}
      <ul ref={list} className={`search-results ${stale && result ? 'stale' : ''}`} aria-label="Resultados de búsqueda" aria-busy={stale && !!result} tabIndex={-1} inert={props.busy} onKeyDown={moveFocus}>
        {rows}
        {more && <li><button className="search-more" onClick={() => setRowLimit(limit => limit + ROW_BUDGET)}>Mostrar más resultados</button></li>}
      </ul>
    </>}
    {confirm && <ConfirmReplace message={confirm.message} fallbackFocus={() => replaceInput.current} onCancel={() => setConfirm(null)} onConfirm={() => { const spec = confirm; setConfirm(null); void replace(spec.entries, spec.options, spec.replacement); }} />}
  </aside>;
}
