import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { FilePlus2, FolderPlus, FolderOpen, Moon, Sun, Search, Pencil, ArrowRightToLine, Trash2, X, ChevronsLeft, Menu, MoreHorizontal, LockKeyhole, KeyRound } from 'lucide-react';
import type { NoteDocument, PrivateDraftInfo, PrivateSessionStatus, VaultEntry, VaultInfo } from '../shared/types';
import MarkdownEditor from './editor/MarkdownEditor';
import HtmlEditor from './editor/HtmlEditor';
import { htmlText } from './editor/htmlDocument';
import { NOTE_EXTENSIONS, noteFormat, stripNoteExtension, withNoteExtension, type NoteFormat } from '../shared/notes';
import { parseWikiLink, resolveWikiLink } from './editor/wikilinks';
import FileTree from './components/FileTree';
import ContextMenu from './components/ContextMenu';
import EntryDialog, { type DialogSpec } from './components/EntryDialog';
import PrivatePasswordDialog, { type PasswordMode } from './components/PrivatePasswordDialog';
import { baseName, errorMessage, flattenEntries, isWithin, parentPath, replacePrefix } from './lib/paths';
import { canMoveEntry, ENTRY_DRAG_TYPE, readEntryDrag, type EntryDragSession } from './lib/treeDnd';
import './styles.css';

type ActiveNote = NoteDocument & { savedContent: string; conflict: boolean; missing?: boolean };
const preference = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } };
const remember = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preferences are optional. */ } };

export default function App() {
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const vaultRef = useRef<VaultInfo | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [note, setNote] = useState<ActiveNote | null>(null);
  const noteRef = useRef<ActiveNote | null>(null);
  const [selected, setSelected] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => preference('boveda.theme', 'dark'));
  const [sourceMode, setSourceMode] = useState(false);
  const [focusHeading, setFocusHeading] = useState<string>();
  const [focusRequest, setFocusRequest] = useState(0);
  const [busy, setBusy] = useState(true);
  const busyRef = useRef(true);
  const closeRequested = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState(false);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [entryMenu, setEntryMenu] = useState(false);
  // `parent` is where "Nueva nota/carpeta" create (none for notes); `entry` adds the selected entry's actions.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; parent?: string; entry: boolean } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const dragSession = useRef<EntryDragSession | null>(null);
  const hoverFolder = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshId = useRef(0);
  const [privateStatus, setPrivateStatus] = useState<PrivateSessionStatus | null>(null);
  const statusRef = useRef<PrivateSessionStatus | null>(null);
  const generation = useRef(0);
  const statusEvents = useRef(0);
  const revokedSessions = useRef(new Set<string>());
  const lockAcknowledgement = useRef(false);
  const draftRevision = useRef(0);
  const [passwordMode, setPasswordMode] = useState<PasswordMode | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [privateDrafts, setPrivateDrafts] = useState<PrivateDraftInfo[]>([]);
  const [discardDraft, setDiscardDraft] = useState<string | null>(null);
  const capture = useCallback(() => ({ generation: generation.current, vault: vaultRef.current?.path, sessionId: statusRef.current?.sessionId }), []);
  const valid = useCallback((request: ReturnType<typeof capture>) => request.generation === generation.current && request.vault === vaultRef.current?.path && request.sessionId === statusRef.current?.sessionId, []);
  const updateNote = useCallback((next: ActiveNote | null) => {
    if (next?.encrypted && !next.locked && (!statusRef.current?.unlocked || next.sessionId !== statusRef.current.sessionId)) return;
    const safe = next?.locked ? { ...next, content: '', savedContent: '', conflict: false } : next;
    noteRef.current = safe; setNote(safe);
  }, []);
  const readNote = useCallback(async (path: string) => {
    const request = capture();
    const document = await window.vault.readNote(path);
    if (!valid(request) || (document.encrypted && !document.locked && document.sessionId !== request.sessionId)) throw new Error('PRIVATE_STALE: La sesión privada cambió.');
    return document;
  }, [capture, valid]);
  const clearVaultContent = useCallback(() => {
    ++generation.current; ++refreshId.current;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    hoverFolder.current = null; dragSession.current = null;
    updateNote(null); setEntries([]); setSelected(''); setExpanded(new Set()); setQuery('');
    setFocusHeading(undefined); setFocusRequest(0); setSourceMode(false);
    setDialog(null); setDialogError(''); setPasswordMode(null); setPasswordError(''); setEntryMenu(false); setContextMenu(null);
    setPrivateDrafts([]); setDiscardDraft(null); setDraggingPath(null); setDropPath(null);
    setSaving(false); setSaveError(false); setError('');
  }, [updateNote]);
  const applyPrivateStatus = useCallback((next: PrivateSessionStatus) => {
    if (vaultRef.current && next.vaultPath !== (vaultRef.current.parentPath ?? vaultRef.current.path)) return;
    if (next.unlocked && next.sessionId && revokedSessions.current.has(next.sessionId)) return;
    const previous = statusRef.current;
    if (previous?.sessionId !== next.sessionId || previous?.unlocked !== next.unlocked || previous?.vaultPath !== next.vaultPath) ++generation.current;
    if (!next.unlocked) {
      if (previous?.sessionId) revokedSessions.current.add(previous.sessionId);
      if (vaultRef.current?.kind === 'private' || noteRef.current?.encrypted) clearVaultContent();
      setDialog(null); setDialogError(''); setPasswordMode(null); setPasswordError(''); setEntryMenu(false);
      setPrivateDrafts([]); setDiscardDraft(null);
      lockAcknowledgement.current = true;
    }
    statusRef.current = next; setPrivateStatus(next);
  }, [clearVaultContent]);
  const applyVault = useCallback((next: VaultInfo | null) => {
    if (vaultRef.current?.path !== next?.path || vaultRef.current?.kind !== next?.kind) {
      clearVaultContent();
      if (statusRef.current?.vaultPath !== (next?.parentPath ?? next?.path)) { statusRef.current = null; setPrivateStatus(null); }
    }
    vaultRef.current = next;
    setVault(next);
    setExpanded(new Set(next && next.kind !== 'private' ? preference<string[]>(`boveda.expanded.${next.path}`, []) : []));
    setQuery(''); setSelected(''); setEntryMenu(false);
  }, [clearVaultContent]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (savePromise.current) return savePromise.current;
    if (noteRef.current?.conflict) return false;
    if (noteRef.current?.locked) return true;
    const request = capture();
    const privateWrite = !!noteRef.current?.encrypted;
    const saveValid = () => privateWrite ? valid(request) : request.vault === vaultRef.current?.path && vaultRef.current?.kind !== 'private' && !!noteRef.current && !noteRef.current.encrypted;
    const work = async () => {
      try {
        let current = noteRef.current;
        while (current && current.content !== current.savedContent) {
          if (current.conflict || !saveValid() || (current.encrypted && (!statusRef.current?.unlocked || current.sessionId !== request.sessionId))) return false;
          setSaving(true);
          const snapshot = current;
          const saved = await window.vault.writeNote(snapshot.path, snapshot.content, snapshot.version, snapshot.encrypted ? snapshot.sessionId : undefined);
          if (!saveValid()) return false;
          const latest = noteRef.current;
          if (latest?.path === snapshot.path) updateNote({ ...latest, version: saved.version, savedContent: snapshot.content });
          current = noteRef.current;
        }
        setSaveError(false);
        setError(previous => previous.startsWith('No se ha podido guardar.') ? '' : previous);
        return true;
      } catch (reason) {
        if (!saveValid()) return false;
        const current = noteRef.current;
        if (current) {
          try {
            const external = await readNote(current.path);
            if (saveValid() && noteRef.current?.path === current.path && external.version !== current.version) updateNote({ ...noteRef.current, conflict: true });
          } catch {
            if (saveValid() && noteRef.current && errorMessage(reason).includes('CONFLICT:')) updateNote({ ...noteRef.current, conflict: true, missing: true });
          }
        }
        if (!saveValid()) return false;
        setSaveError(true);
        setError(`No se ha podido guardar. ${errorMessage(reason)}`);
        return false;
      } finally { if (saveValid()) setSaving(false); }
    };
    savePromise.current = work();
    try { return await savePromise.current; } finally { savePromise.current = null; }
  }, [capture, valid, readNote, updateNote]);

  const runAction = useCallback(async (action: () => Promise<void>, requireSave = true): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError('');
    const request = capture();
    try {
      if (requireSave && !await flush() && !((noteRef.current?.locked || !noteRef.current) && await flush())) {
        if (noteRef.current?.conflict) setError('Guarda una copia o descarta los cambios antes de continuar.');
        return false;
      }
      await action(); return true;
    } catch (reason) { if (valid(request) && !errorMessage(reason).startsWith('PRIVATE_STALE:')) setError(errorMessage(reason)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }, [flush, capture, valid]);

  const refresh = useCallback(async function refreshVault() {
    if (!vaultRef.current) return;
    if (busyRef.current) { refreshTimer.current = setTimeout(() => { void refreshVault(); }, 220); return; }
    const id = ++refreshId.current;
    const request = capture();
    try {
      const tree = await window.vault.listEntries();
      if (id !== refreshId.current || !valid(request)) return;
      if (busyRef.current) { refreshTimer.current = setTimeout(() => { void refreshVault(); }, 220); return; }
      setEntries(tree);
      if (savePromise.current) await savePromise.current;
      const current = noteRef.current;
      if (!current || busyRef.current) return;
      try {
        const disk = await readNote(current.path);
        const latest = noteRef.current;
        if (!valid(request) || id !== refreshId.current || busyRef.current || latest?.path !== current.path || savePromise.current) return;
        if (latest.version !== current.version) { refreshTimer.current = setTimeout(() => { void refreshVault(); }, 220); return; }
        if (disk.version !== latest.version) {
          if (latest.content !== latest.savedContent || latest.conflict) updateNote({ ...latest, conflict: true });
          else updateNote({ ...disk, savedContent: disk.content, conflict: false });
        }
      } catch (reason) {
        const latest = noteRef.current;
        if (!valid(request) || id !== refreshId.current || latest?.path !== current.path || busyRef.current) return;
        if (!flattenEntries(tree).some(entry => entry.path === current.path)) updateNote({ ...latest, conflict: true, missing: true });
        else setError(`No se ha podido comprobar la nota. ${errorMessage(reason)}`);
      }
    } catch (reason) { if (valid(request)) setError(errorMessage(reason)); }
  }, [capture, valid, readNote, updateNote]);

  const openNote = useCallback(async (path: string, heading?: string) => {
    await runAction(async () => {
      const request = capture();
      const document = await readNote(path);
      // A pending editor callback can arrive while the file is being read.
      if (!await flush()) throw new Error('La nota actual tiene cambios pendientes.');
      if (!valid(request)) return;
      updateNote({ ...document, savedContent: document.content, conflict: false });
      setSelected(path); setFocusHeading(heading); setFocusRequest(previous => previous + 1); setSaveError(false);
      if (vaultRef.current && vaultRef.current.kind !== 'private') remember(`boveda.lastNote.${vaultRef.current.path}`, path);
      setExpanded(previous => {
        const next = new Set(previous); let parent = parentPath(path);
        while (parent) { next.add(parent); parent = parentPath(parent); }
        return next;
      });
    });
  }, [capture, valid, readNote, flush, runAction, updateNote]);

  // Subscribe before initialization: a lock event also invalidates pending reads.
  useEffect(() => window.vault.onPrivateSessionChanged(status => {
    if (vaultRef.current && status.vaultPath !== (vaultRef.current.parentPath ?? vaultRef.current.path)) return;
    ++statusEvents.current;
    applyPrivateStatus(status);
  }), [applyPrivateStatus]);

  useEffect(() => {
    if (lockAcknowledgement.current && !privateStatus?.unlocked && (!note?.encrypted || note.locked)) {
      lockAcknowledgement.current = false;
      window.vault.acknowledgePrivateLock();
    }
  }, [privateStatus, note, passwordMode]);

  useEffect(() => {
    if (vault?.kind !== 'private' || !privateStatus?.unlocked || !privateStatus.sessionId) return;
    const request = capture();
    void (async () => {
      try {
        const drafts = await window.vault.listPrivateDrafts(privateStatus.sessionId!);
        if (!valid(request)) return;
        setPrivateDrafts(drafts);
        const tree = await window.vault.listEntries();
        if (valid(request)) setEntries(tree);
      } catch (reason) { if (valid(request)) setError(errorMessage(reason)); }
    })();
  }, [vault?.path, vault?.kind, privateStatus?.unlocked, privateStatus?.sessionId, capture, valid]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const currentVault = await window.vault.getVault();
        if (cancelled) return;
        applyVault(currentVault);
        if (currentVault) {
          const eventCount = statusEvents.current;
          const status = await window.vault.getPrivateSession();
          if (cancelled) return;
          if (eventCount === statusEvents.current) applyPrivateStatus(status);
          const request = capture();
          const tree = await window.vault.listEntries();
          if (cancelled || !valid(request)) return;
          setEntries(tree);
          const last = currentVault.kind === 'private' ? '' : preference<string>(`boveda.lastNote.${currentVault.path}`, '');
          if (last && flattenEntries(tree).some(entry => entry.path === last && entry.type === 'file')) {
            const document = await readNote(last);
            if (!cancelled && valid(request)) { updateNote({ ...document, savedContent: document.content, conflict: false }); setSelected(last); }
          }
        }
      } catch (reason) { if (!cancelled && !errorMessage(reason).startsWith('PRIVATE_STALE:')) setError(errorMessage(reason)); }
      finally { if (!cancelled) { setLoading(false); busyRef.current = false; setBusy(false); } }
    })();
    return () => { cancelled = true; };
  }, [applyVault, applyPrivateStatus, capture, valid, readNote, updateNote]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    remember('boveda.theme', theme);
  }, [theme]);
  useEffect(() => { if (vault && vault.kind !== 'private') remember(`boveda.expanded.${vault.path}`, [...expanded]); }, [vault, expanded]);
  useEffect(() => {
    const unsubscribe = window.vault.onVaultChanged(() => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => { void refresh(); }, 220);
    });
    const unsubscribeClose = window.vault.onBeforeClose(() => {
      closeRequested.current = true;
      if (!busyRef.current) {
        closeRequested.current = false;
        void runAction(async () => { window.vault.confirmClose(); });
      }
    });
    return () => { unsubscribe(); unsubscribeClose(); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [refresh, runAction]);
  useEffect(() => {
    if (!busy && closeRequested.current) {
      closeRequested.current = false;
      void runAction(async () => { window.vault.confirmClose(); });
    }
  }, [busy, runAction]);

  function changeContent(content: string) {
    const current = noteRef.current;
    if (!current || current.locked || busyRef.current || (current.encrypted && (!statusRef.current?.unlocked || current.sessionId !== statusRef.current.sessionId))) return;
    updateNote({ ...current, content });
    if (current.encrypted && current.sessionId) {
      const request = capture();
      void window.vault.savePrivateDraft(current.path, content, current.version, ++draftRevision.current, current.sessionId).catch(reason => {
        if (valid(request) && noteRef.current?.path === current.path) { setSaveError(true); setError(`No se ha podido guardar el borrador cifrado. ${errorMessage(reason)}`); }
      });
    }
    if (timer.current) clearTimeout(timer.current);
    if (!current.conflict) timer.current = setTimeout(() => { void flush(); }, 450);
  }
  const allEntries = flattenEntries(entries);
  const selectedEntry = allEntries.find(entry => entry.path === selected);
  const selectedFolder = selectedEntry?.type === 'folder' ? selectedEntry.path : selectedEntry ? parentPath(selectedEntry.path) : '';
  const folderPaths = ['', ...allEntries.filter(entry => entry.type === 'folder').map(entry => entry.path)];
  const notePaths = allEntries.filter(entry => entry.type === 'file').map(entry => entry.path);

  function clearHover() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null; hoverFolder.current = null;
  }
  function endEntryDrag() {
    clearHover(); dragSession.current = null; setDraggingPath(null); setDropPath(null);
  }
  useEffect(() => {
    if (busy || note?.conflict) endEntryDrag();
    return () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  }, [busy, note?.conflict]);

  function beginEntryDrag(event: DragEvent<HTMLElement>, path: string) {
    if (busyRef.current || noteRef.current?.conflict || !allEntries.some(entry => entry.path === path)) { event.preventDefault(); return; }
    const session = { path, token: crypto.randomUUID() };
    dragSession.current = session; setDraggingPath(path); setDropPath(null); setEntryMenu(false); setContextMenu(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(ENTRY_DRAG_TYPE, JSON.stringify(session));
  }
  function allowEntryDrop(event: DragEvent<HTMLElement>, destination: string): boolean {
    const session = dragSession.current;
    return !busyRef.current && !noteRef.current?.conflict && !!session &&
      event.dataTransfer.types.includes(ENTRY_DRAG_TYPE) && !event.dataTransfer.types.includes('Files') &&
      canMoveEntry(entries, session.path, destination);
  }
  function overEntryDrop(event: DragEvent<HTMLElement>, destination: string) {
    event.preventDefault(); event.stopPropagation();
    if (!allowEntryDrop(event, destination)) { event.dataTransfer.dropEffect = 'none'; setDropPath(null); clearHover(); return; }
    event.dataTransfer.dropEffect = 'move'; setDropPath(destination);
    if (destination && !expanded.has(destination) && hoverFolder.current !== destination) {
      clearHover(); hoverFolder.current = destination;
      hoverTimer.current = setTimeout(() => {
        if (dragSession.current && !busyRef.current && !noteRef.current?.conflict) setExpanded(previous => new Set(previous).add(destination));
        hoverTimer.current = null;
      }, 600);
    } else if (hoverFolder.current !== destination) clearHover();
  }
  function leaveEntryDrop(event: DragEvent<HTMLElement>, destination: string) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropPath(previous => previous === destination ? null : previous); clearHover();
  }
  function applyEntryPathChange(oldPath: string, newPath: string) {
    const current = noteRef.current;
    if (current && isWithin(current.path, oldPath)) {
      const movedPath = replacePrefix(current.path, oldPath, newPath);
      updateNote({ ...current, path: movedPath }); setFocusHeading(undefined);
      if (vaultRef.current && vaultRef.current.kind !== 'private') remember(`boveda.lastNote.${vaultRef.current.path}`, movedPath);
    }
    setSelected(previous => isWithin(previous, oldPath) ? replacePrefix(previous, oldPath, newPath) : newPath);
    setExpanded(previous => {
      const next = new Set([...previous].map(path => replacePrefix(path, oldPath, newPath)));
      let parent = parentPath(newPath);
      while (parent) { next.add(parent); parent = parentPath(parent); }
      return next;
    });
  }
  async function reloadNoteAfterPathChange(request: ReturnType<typeof capture>) {
    const current = noteRef.current;
    if (!current || !valid(request)) return;
    const document = await readNote(current.path);
    if (valid(request) && noteRef.current?.path === current.path) updateNote({ ...document, savedContent: document.content, conflict: false });
  }
  async function moveEntryTo(path: string, destination: string): Promise<string> {
    const request = capture();
    const movedPath = await window.vault.moveEntry(path, destination);
    if (!valid(request)) throw new Error('PRIVATE_STALE: La bóveda cambió.');
    applyEntryPathChange(path, movedPath);
    await reloadNoteAfterPathChange(request);
    return movedPath;
  }
  async function dropEntry(event: DragEvent<HTMLElement>, destination: string) {
    event.preventDefault(); event.stopPropagation();
    const path = allowEntryDrop(event, destination) ? readEntryDrag(event.dataTransfer.getData(ENTRY_DRAG_TYPE), dragSession.current) : null;
    endEntryDrag();
    if (!path) return;
    await runAction(async () => {
      const request = capture();
      // Recheck the current tree after the pending note has been saved.
      const tree = await window.vault.listEntries();
      if (!valid(request)) return;
      setEntries(tree);
      if (!canMoveEntry(tree, path, destination)) return;
      await moveEntryTo(path, destination);
      const nextTree = await window.vault.listEntries();
      if (valid(request)) setEntries(nextTree);
    });
  }
  function overRootDrop(event: DragEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('[data-entry-path]')) return;
    overEntryDrop(event, '');
  }
  function dropInRoot(event: DragEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('[data-entry-path]')) { event.preventDefault(); endEntryDrag(); return; }
    void dropEntry(event, '');
  }
  function showDialog(spec: DialogSpec) {
    if (busyRef.current || (vaultRef.current?.kind === 'private' && !statusRef.current?.unlocked)) return;
    if (noteRef.current?.conflict) { setError('Guarda una copia o descarta los cambios antes de continuar.'); return; }
    setEntryMenu(false); setContextMenu(null); setDialogError(''); setDialog(spec);
  }
  function create(kind: 'note' | 'folder', parent = selectedFolder) { if (!vaultRef.current || (vaultRef.current.kind === 'private' && !statusRef.current?.unlocked)) return; showDialog({ kind, title: kind === 'note' ? 'Nueva nota' : 'Nueva carpeta', path: parent }); }
  // No entry: the vault root. A folder creates inside itself; a note only offers its actions.
  function openContextMenu(event: MouseEvent, entry?: VaultEntry) {
    event.preventDefault(); event.stopPropagation(); setEntryMenu(false);
    if (!canEdit || dialog || dragSession.current) { setContextMenu(null); return; }
    if (entry) setSelected(entry.path);
    setContextMenu({ x: event.clientX, y: event.clientY, parent: entry ? entry.type === 'folder' ? entry.path : undefined : '', entry: !!entry });
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!busyRef.current) void flush(); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); if (!dialog) create('note'); }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  async function changeVault() {
    await runAction(async () => {
      const next = await window.vault.openVault();
      if (!next) return;
      ++refreshId.current;
      updateNote(null); applyVault(next);
      const eventCount = statusEvents.current;
      const status = await window.vault.getPrivateSession();
      if (vaultRef.current?.path !== next.path) return;
      if (eventCount === statusEvents.current) applyPrivateStatus(status);
      const request = capture();
      const tree = await window.vault.listEntries();
      if (!valid(request)) return;
      setEntries(tree); setSaveError(false);
      const last = next.kind === 'private' ? '' : preference<string>(`boveda.lastNote.${next.path}`, '');
      if (last) {
        try { const document = await readNote(last); if (valid(request)) { updateNote({ ...document, savedContent: document.content, conflict: false }); setSelected(last); } } catch { /* A removed last note leaves the vault open. */ }
      }
    });
  }

  async function switchVaultMode(mode: 'normal' | 'private') {
    if (!vaultRef.current || (vaultRef.current.kind ?? 'normal') === mode || passwordBusy) return;
    await runAction(async () => {
      clearVaultContent();
      const next = await window.vault.selectVaultMode(mode);
      applyVault(next);
      const eventCount = statusEvents.current;
      const status = await window.vault.getPrivateSession();
      if (vaultRef.current?.path !== next.path) return;
      if (eventCount === statusEvents.current) applyPrivateStatus(status);
      const request = capture();
      const tree = await window.vault.listEntries();
      if (!valid(request)) return;
      setEntries(tree);
      const last = mode === 'normal' ? preference<string>(`boveda.lastNote.${next.path}`, '') : '';
      if (last && flattenEntries(tree).some(entry => entry.path === last && entry.type === 'file')) {
        const document = await readNote(last);
        if (valid(request)) { updateNote({ ...document, savedContent: document.content, conflict: false }); setSelected(last); }
      }
    });
  }

  function openPassword(mode?: PasswordMode) {
    if (vaultRef.current?.kind !== 'private' || busyRef.current || passwordBusy) return;
    setEntryMenu(false); setPasswordError('');
    setPasswordMode(mode ?? (statusRef.current?.configured ? 'unlock' : 'setup'));
  }

  async function submitPassword(password: string, currentPassword: string) {
    if (!passwordMode || passwordBusy) return;
    const mode = passwordMode; const request = capture(); const eventCount = statusEvents.current;
    setPasswordBusy(true); setPasswordError('');
    try {
      if (mode === 'change') {
        if (!request.sessionId || !statusRef.current?.unlocked) throw new Error('Abre la sesión privada.');
        const operation = window.vault.changePrivatePassword(currentPassword, password, request.sessionId);
        password = ''; currentPassword = '';
        await operation;
        if (!valid(request)) return;
      } else {
        const operation = mode === 'setup' ? window.vault.setupPrivateSession(password) : window.vault.unlockPrivateSession(password);
        password = ''; currentPassword = '';
        const status = await operation;
        if (request.vault !== vaultRef.current?.path || status.vaultPath !== (vaultRef.current?.parentPath ?? request.vault)) return;
        if (eventCount === statusEvents.current && valid(request)) applyPrivateStatus(status);
        else if (!statusRef.current?.unlocked || statusRef.current.sessionId !== status.sessionId) return;
      }
      setPasswordMode(null);
    } catch (reason) { if (request.vault === vaultRef.current?.path && (valid(request) || statusRef.current?.unlocked)) setPasswordError(errorMessage(reason)); }
    finally { setPasswordBusy(false); }
  }

  async function lockSession() {
    if (passwordBusy) return;
    const previous = statusRef.current;
    if (!previous?.unlocked) return;
    // Revoke locally before IPC can yield a late save or read response.
    applyPrivateStatus({ ...previous, unlocked: false, sessionId: null });
    const eventCount = statusEvents.current; const vaultPath = previous.vaultPath;
    try {
      const status = await window.vault.lockPrivateSession();
      if ((vaultRef.current?.parentPath ?? vaultRef.current?.path) === vaultPath && eventCount === statusEvents.current) applyPrivateStatus(status);
    } catch (reason) { if ((vaultRef.current?.parentPath ?? vaultRef.current?.path) === vaultPath) setError(errorMessage(reason)); }
  }

  async function recoverDraft(id: string, discard = false) {
    await runAction(async () => {
      const request = capture();
      if (!request.sessionId || !statusRef.current?.unlocked) return;
      if (discard) await window.vault.discardPrivateDraft(id, request.sessionId);
      else {
        const document = await window.vault.recoverPrivateDraft(id, request.sessionId);
        if (!valid(request)) return;
        updateNote({ ...document, savedContent: document.content, conflict: false }); setSelected(document.path); setFocusHeading(undefined);
      }
      const drafts = await window.vault.listPrivateDrafts(request.sessionId);
      if (!valid(request)) return;
      setPrivateDrafts(drafts); setDiscardDraft(null);
      const tree = await window.vault.listEntries();
      if (valid(request)) setEntries(tree);
    }, !discard);
  }

  async function submitDialog(value: string, format: NoteFormat = 'md') {
    if (!dialog) return;
    const spec = dialog;
    setDialogError('');
    let operationStarted = false;
    const success = await runAction(async () => {
      const request = capture();
      if (vaultRef.current?.kind === 'private' && !statusRef.current?.unlocked) return;
      operationStarted = true;
      try {
        let nextDocument: NoteDocument | undefined;
        let newPath = '';
        if (spec.kind === 'note') nextDocument = await window.vault.createNote(spec.path, value, format);
        if (spec.kind === 'folder') { newPath = await window.vault.createFolder(spec.path, value); if (valid(request)) setSelected(newPath); }
        if (spec.kind === 'rename') newPath = await window.vault.renameEntry(spec.path, value);
        if (spec.kind === 'move') newPath = await moveEntryTo(spec.path, value);
        if (spec.kind === 'trash') {
          await window.vault.trashEntry(spec.path);
          if (!valid(request)) return;
          if (noteRef.current && isWithin(noteRef.current.path, spec.path)) updateNote(null);
          setSelected(parentPath(spec.path));
        }
        if (spec.kind === 'missing') {
          const parts = spec.path.split('/');
          let parent = '';
          const knownFolders = new Set(folderPaths);
          for (const part of parts.slice(0, -1)) {
            const path = parent ? `${parent}/${part}` : part;
            if (!knownFolders.has(path)) { await window.vault.createFolder(parent, part); if (!valid(request)) return; }
            parent = path;
          }
          nextDocument = await window.vault.createNote(parent, parts.at(-1)!, noteFormat(spec.path) ?? 'md');
        }
        if (!valid(request)) return;
        if (newPath && spec.kind === 'rename') {
          applyEntryPathChange(spec.path, newPath);
          await reloadNoteAfterPathChange(request);
          if (!valid(request)) return;
        }
        if (nextDocument) {
          if (!await flush()) throw new Error('La nota actual tiene cambios pendientes. La nueva nota ya está creada.');
          if (!valid(request)) return;
          updateNote({ ...nextDocument, savedContent: nextDocument.content, conflict: false }); setSelected(nextDocument.path); setFocusHeading(spec.heading); setFocusRequest(previous => previous + 1);
          if (vaultRef.current && vaultRef.current.kind !== 'private') remember(`boveda.lastNote.${vaultRef.current.path}`, nextDocument.path);
        }
        const expandedPath = nextDocument ? parentPath(nextDocument.path) : spec.kind === 'folder' ? newPath : parentPath(newPath);
        if (expandedPath) setExpanded(previous => { const next = new Set(previous); let path = expandedPath; while (path) { next.add(path); path = parentPath(path); } return next; });
        const tree = await window.vault.listEntries();
        if (valid(request)) setEntries(tree);
      } catch (reason) { if (valid(request)) setDialogError(errorMessage(reason)); throw reason; }
    });
    if (success) { setDialog(null); setSaveError(false); }
    else if (!operationStarted) setDialogError('No se ha podido guardar la nota actual. Cancela este diálogo para revisar el aviso.');
  }

  function navigateWiki(target: string) {
    const current = noteRef.current;
    if (!current || busyRef.current) return;
    const parsed = parseWikiLink(target);
    const resolved = resolveWikiLink(target, current.path, notePaths);
    if (resolved) { void openNote(resolved, parsed.heading); return; }
    const raw = parsed.path.trim().replace(/\\/g, '/');
    if (!raw) return;
    const relative = raw.startsWith('./') || raw.startsWith('../');
    const parts = (relative ? `${parentPath(current.path)}/${raw}` : raw.replace(/^\//, '')).split('/');
    const clean: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!clean.length) { setError('El enlace apunta fuera de la bóveda.'); return; } clean.pop(); }
      else clean.push(part);
    }
    // A new linked note keeps the link's extension, otherwise the format of the linking note.
    const path = withNoteExtension(clean.join('/'), noteFormat(current.path) ?? 'md');
    showDialog({ kind: 'missing', title: 'Crear nota enlazada', path, heading: parsed.heading });
  }

  async function reloadConflict() {
    await runAction(async () => {
      const request = capture();
      const current = noteRef.current;
      if (!current) return;
      if (current.missing) updateNote(null);
      else { const document = await readNote(current.path); if (!valid(request)) return; updateNote({ ...document, savedContent: document.content, conflict: false }); }
      setSaveError(false); setError('');
    }, false);
  }
  async function saveCopy() {
    await runAction(async () => {
      const current = noteRef.current;
      if (!current || current.locked) return;
      const request = capture();
      const tree = flattenEntries(await window.vault.listEntries());
      const parent = parentPath(current.path);
      const destination = !parent || tree.some(entry => entry.path === parent && entry.type === 'folder') ? parent : '';
      const name = stripNoteExtension(baseName(current.path));
      const extension = NOTE_EXTENSIONS[noteFormat(current.path) ?? 'md'];
      // A copy may not share its name with a note in the other format either.
      const taken = (candidate: string) => tree.some(entry => stripNoteExtension(entry.path).toLocaleLowerCase() === stripNoteExtension((destination ? `${destination}/` : '') + candidate).toLocaleLowerCase());
      let copyName = `${name} copia${extension}`; let count = 2;
      while (taken(copyName)) copyName = `${name} copia ${count++}${extension}`;
      if (!valid(request)) return;
      let saved: NoteDocument;
      let content = noteRef.current?.content ?? current.content;
      if (current.encrypted) {
        if (!request.sessionId) return;
        saved = await window.vault.createPrivateCopy(destination, copyName, content, request.sessionId);
      } else {
        const copy = await window.vault.createNote(destination, copyName);
        saved = copy;
        do {
          if (!valid(request)) return;
          content = noteRef.current?.content ?? content;
          saved = await window.vault.writeNote(copy.path, content, saved.version);
        } while (valid(request) && noteRef.current?.path === current.path && noteRef.current.content !== content);
      }
      if (!valid(request)) return;
      updateNote({ ...saved, savedContent: saved.content, conflict: false }); setSelected(saved.path); setSaveError(false);
      const nextTree = await window.vault.listEntries();
      if (!valid(request)) return;
      setEntries(nextTree);
      if (vaultRef.current && vaultRef.current.kind !== 'private') remember(`boveda.lastNote.${vaultRef.current.path}`, saved.path);
    }, false);
  }

  const privateVault = vault?.kind === 'private';
  const privateLocked = privateVault && !privateStatus?.unlocked;
  const canEdit = !busy && !passwordBusy && !privateLocked;
  const htmlNote = !!note && noteFormat(note.path) === 'html';
  const visibleText = note ? (htmlNote ? htmlText(note.content) : note.content).trim() : '';
  const words = visibleText ? visibleText.split(/\s+/u).length : 0;
  const NoteEditor = htmlNote ? HtmlEditor : MarkdownEditor;
  const dirty = !!note && note.content !== note.savedContent;
  useEffect(() => { if (!canEdit || dialog || draggingPath || (contextMenu?.entry && !selectedEntry)) setContextMenu(null); }, [canEdit, dialog, draggingPath, contextMenu, selectedEntry]);
  const mutationButtons = selectedEntry && <>
    <button role="menuitem" onClick={() => showDialog({ kind: 'rename', title: 'Renombrar', path: selectedEntry.path, initialValue: selectedEntry.type === 'file' ? stripNoteExtension(selectedEntry.name) : selectedEntry.name })}><Pencil size={15} />Renombrar</button>
    <button role="menuitem" onClick={() => showDialog({ kind: 'move', title: 'Mover', path: selectedEntry.path, initialValue: parentPath(selectedEntry.path), folders: folderPaths.filter(folder => selectedEntry.type !== 'folder' || !isWithin(folder, selectedEntry.path)) })}><ArrowRightToLine size={15} />Mover</button>
    <button role="menuitem" className="danger-text" onClick={() => showDialog({ kind: 'trash', title: privateVault ? 'Eliminar' : 'Enviar a la papelera', path: selectedEntry.path, permanent: privateVault })}><Trash2 size={15} />{privateVault ? 'Eliminar' : 'Papelera'}</button>
  </>;

  return <div className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`} data-theme={theme}>
    {vault && sidebarVisible && <aside className="sidebar" aria-label="Bóveda">
      <header className="vault-header" onContextMenu={event => openContextMenu(event)}><button className={`vault-name ${dropPath === '' ? 'drop-target' : ''}`} title={vault.path} data-drop-path="" onDragOver={event => overEntryDrop(event, '')} onDragLeave={event => leaveEntryDrop(event, '')} onDrop={event => void dropEntry(event, '')} onClick={() => { setSelected(''); setEntryMenu(false); }}><FolderOpen size={17} /><span>{vault.name}</span></button><button className="icon-button" title="Ocultar archivos" aria-label="Ocultar archivos" onClick={() => setSidebarVisible(false)}><ChevronsLeft size={17} /></button></header>
      <div className="vault-switch" role="group" aria-label="Tipo de bóveda"><button aria-pressed={!privateVault} disabled={busy || passwordBusy} onClick={() => void switchVaultMode('normal')}>Normal</button><button aria-pressed={privateVault} disabled={busy || passwordBusy} onClick={() => void switchVaultMode('private')}>Privada</button></div>
      {!privateLocked && <div className="sidebar-tools"><button className="icon-button" aria-label="Nueva nota" title="Nueva nota (Ctrl+N)" disabled={!canEdit} onClick={() => create('note')}><FilePlus2 size={17} /></button><button className="icon-button" aria-label="Nueva carpeta" title="Nueva carpeta" disabled={!canEdit} onClick={() => create('folder')}><FolderPlus size={17} /></button><div className="entry-menu-anchor"><button className="icon-button" aria-label="Acciones del archivo" title="Acciones del archivo" disabled={!selectedEntry || !canEdit} onClick={() => setEntryMenu(!entryMenu)}><MoreHorizontal size={18} /></button>{entryMenu && <><button className="menu-dismiss" aria-label="Cerrar menú" onClick={() => setEntryMenu(false)} /><div role="menu" className="entry-menu">{mutationButtons}</div></>}</div><span className="tool-spacer" /></div>}
      {!privateLocked && <label className="search-field"><Search size={15} /><input aria-label="Buscar archivos" placeholder="Buscar archivos" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="Limpiar búsqueda" onClick={() => setQuery('')}><X size={14} /></button>}</label>}
      <nav className={`tree-scroll ${dropPath === '' ? 'root-drop-target' : ''}`} inert={!canEdit} data-drop-path="" onContextMenu={event => openContextMenu(event)} onDragOver={overRootDrop} onDragLeave={event => leaveEntryDrop(event, '')} onDrop={dropInRoot}><FileTree entries={privateLocked ? [] : entries} expanded={expanded} selected={selected} current={note?.path} query={query} canDrag={canEdit && !note?.conflict} draggingPath={draggingPath} dropPath={dropPath} onDragStart={beginEntryDrag} onDragEnd={endEntryDrag} onDragOver={overEntryDrop} onDragLeave={leaveEntryDrop} onDrop={(event, path) => void dropEntry(event, path)} onToggle={path => setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })} onSelect={entry => { setEntryMenu(false); if (entry.type === 'file') void openNote(entry.path); else { setSelected(entry.path); setExpanded(previous => new Set(previous).add(entry.path)); } }} onContext={openContextMenu} />{!privateLocked && entries.length === 0 && <p className="tree-empty">La bóveda está vacía.</p>}{entries.length > 0 && query && !allEntries.some(entry => entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p className="tree-empty">Sin resultados.</p>}{draggingPath && <div className="root-drop-hint">Soltar aquí para mover a la raíz</div>}</nav>
      {privateVault && privateStatus?.unlocked && <div className="private-controls"><button disabled={passwordBusy} onClick={() => void lockSession()}><LockKeyhole size={15} />Bloquear bóveda</button><button className="icon-button" title="Cambiar contraseña" aria-label="Cambiar contraseña" disabled={busy || passwordBusy} onClick={() => openPassword('change')}><KeyRound size={15} /></button></div>}
      <footer className="sidebar-footer"><button onClick={() => void changeVault()} disabled={busy}><FolderOpen size={15} />Cambiar bóveda</button><button className="icon-button" title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} aria-label={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button></footer>
    </aside>}
    <main className="main-pane">
      {vault && <header className="note-toolbar">{!sidebarVisible && <button className="icon-button" title="Mostrar archivos" aria-label="Mostrar archivos" onClick={() => setSidebarVisible(true)}><Menu size={18} /></button>}<span className="note-path" title={note?.path}>{note ? <><span className="path-parent">{parentPath(note.path) ? `${parentPath(note.path)} / ` : ''}</span>{stripNoteExtension(baseName(note.path))}</> : vault.name}</span>{note?.encrypted && <LockKeyhole size={15} aria-label="Nota cifrada" />}{note && !note.locked && <button className="view-toggle" title={sourceMode ? `Ver ${htmlNote ? 'HTML' : 'Markdown'} en vivo` : `Ver código ${htmlNote ? 'HTML' : 'Markdown'}`} onClick={() => setSourceMode(!sourceMode)}>{sourceMode ? 'Código fuente' : 'Vista en vivo'}</button>}{!sidebarVisible && privateVault && privateStatus?.unlocked && <button className="icon-button" aria-label="Bloquear bóveda" onClick={() => void lockSession()}><LockKeyhole size={16} /></button>}</header>}
      {privateVault && privateStatus?.error && <div className="error-bar" role="alert"><span>{privateStatus.error}</span></div>}
      {privateVault && privateDrafts.length > 0 && privateStatus?.unlocked && <div className="private-recovery" aria-label="Borradores cifrados"><p>Borradores cifrados pendientes</p>{privateDrafts.map(draft => <div key={draft.id}><span>{draft.path}</span>{discardDraft === draft.id ? <><span>¿Descartar este borrador?</span><button disabled={busy} onClick={() => void recoverDraft(draft.id, true)}>Sí, descartar</button><button disabled={busy} onClick={() => setDiscardDraft(null)}>Cancelar</button></> : <><button disabled={busy} onClick={() => void recoverDraft(draft.id)}>Recuperar copia</button><button disabled={busy} onClick={() => setDiscardDraft(draft.id)}>Descartar borrador</button></>}</div>)}</div>}
      {error && !note?.conflict && <div className="error-bar" role="alert"><span>{error}</span>{saveError && <button disabled={busy || saving} onClick={() => void flush()}>Reintentar</button>}<button className="icon-button" aria-label="Cerrar aviso" onClick={() => setError('')}><X size={15} /></button></div>}
      {privateVault && privateStatus?.unlocked && !!privateStatus.recoveryPending && <div className="private-recovery" role="status"><p>{privateStatus.recoveryPending === 1 ? 'Un archivo de recuperación no cabe' : `${privateStatus.recoveryPending} archivos de recuperación no caben`} en la bóveda privada (16 MiB). Siguen cifrados en disco: recupera o descarta borradores, o libera espacio, y vuelve a desbloquear para incorporarlos.</p></div>}
      {note?.conflict && <div className="conflict-bar" role="alert"><p>{note.missing ? 'Esta nota ya no está disponible en la bóveda.' : 'La nota cambió fuera de la aplicación. Tus cambios siguen aquí.'}</p><div><button disabled={busy} onClick={() => void saveCopy()}>Guardar una copia</button><button disabled={busy} onClick={() => void reloadConflict()}>Descartar y {note.missing ? 'cerrar' : 'recargar'}</button></div>{error && <p className="conflict-detail">{error}</p>}</div>}
      {loading ? <div className="empty-state"><p>Abriendo bóveda…</p></div> : !vault ? <div className="welcome"><FolderOpen size={33} strokeWidth={1.3} /><h1>Black Cobble</h1><p>Tus notas Markdown y HTML en una carpeta.</p><button className="primary-button" disabled={busy} onClick={() => void changeVault()}>{busy ? 'Abriendo…' : 'Abrir o crear una bóveda'}</button><button className="theme-text" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}</button></div> : privateLocked ? <div className="empty-state locked-note"><LockKeyhole size={25} /><p>{privateStatus?.configured ? 'Bóveda privada bloqueada' : 'Crea tu bóveda privada'}</p><button className="primary-button" disabled={busy || passwordBusy || !!privateStatus?.error} onClick={() => openPassword()}>{privateStatus?.configured ? 'Desbloquear bóveda' : 'Crear contraseña'}</button></div> : note ? <><div className="editor-wrap" inert={busy} aria-busy={busy}><NoteEditor key={`${vault.path}:${note.path}:${note.encrypted ? note.sessionId : 'public'}`} value={note.content} onChange={changeContent} notePath={note.path} notePaths={notePaths} onNavigate={navigateWiki} sourceMode={sourceMode} privateMode={privateVault} theme={theme} focusHeading={focusHeading} navigationId={focusRequest} /></div><footer className="note-status"><span aria-live="polite">{note.conflict ? 'Cambios sin guardar' : saving ? 'Guardando…' : saveError ? 'No se ha guardado' : dirty ? 'Cambios pendientes' : 'Guardado'}</span><span>{words} {words === 1 ? 'palabra' : 'palabras'}</span></footer></> : <div className="empty-state"><p>Abre una nota o crea una nueva.</p><button className="primary-button" disabled={!canEdit} onClick={() => create('note')}><FilePlus2 size={16} />Nueva nota</button></div>}
    </main>
    {dialog && <EntryDialog key={`${dialog.kind}:${dialog.path}`} spec={dialog} busy={busy} error={dialogError} onCancel={() => { setDialog(null); setError(''); }} onSubmit={(value, format) => void submitDialog(value, format)} />}
    {contextMenu && canEdit && <ContextMenu x={contextMenu.x} y={contextMenu.y} label={contextMenu.entry ? 'Acciones del archivo' : 'Acciones de la bóveda'} onClose={closeContextMenu}>
      {contextMenu.parent !== undefined && <><button role="menuitem" onClick={() => create('note', contextMenu.parent)}><FilePlus2 size={15} />Nueva nota</button><button role="menuitem" onClick={() => create('folder', contextMenu.parent)}><FolderPlus size={15} />Nueva carpeta</button></>}
      {contextMenu.parent !== undefined && contextMenu.entry && <div role="separator" className="menu-separator" />}
      {contextMenu.entry && mutationButtons}
    </ContextMenu>}
    {passwordMode && <PrivatePasswordDialog key={passwordMode} mode={passwordMode} busy={passwordBusy} error={passwordError} onCancel={() => { setPasswordMode(null); setPasswordError(''); }} onSubmit={submitPassword} />}
  </div>;
}
