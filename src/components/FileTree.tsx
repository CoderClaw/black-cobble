import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, LockKeyhole } from 'lucide-react';
import type { DragEvent } from 'react';
import type { VaultEntry } from '../../shared/types';
import { noteFormat, stripNoteExtension } from '../../shared/notes';

interface Props {
  entries: VaultEntry[];
  expanded: Set<string>;
  selected: string;
  current?: string;
  query: string;
  onSelect: (entry: VaultEntry) => void;
  onToggle: (path: string) => void;
  onContext: (entry: VaultEntry) => void;
  canDrag: boolean;
  draggingPath: string | null;
  dropPath: string | null;
  onDragStart: (event: DragEvent<HTMLElement>, path: string) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>, destination: string) => void;
  onDragLeave: (event: DragEvent<HTMLElement>, destination: string) => void;
  onDrop: (event: DragEvent<HTMLElement>, destination: string) => void;
}

export default function FileTree(props: Props) {
  const query = props.query.trim().toLocaleLowerCase();
  const matches = (entry: VaultEntry): boolean => entry.name.toLocaleLowerCase().includes(query) || !!entry.children?.some(matches);
  function render(entries: VaultEntry[], depth: number) {
    return entries.filter(entry => !query || matches(entry)).map(entry => {
      const folder = entry.type === 'folder';
      const open = props.expanded.has(entry.path) || !!query;
      const Icon = folder ? open ? FolderOpen : Folder : entry.encrypted ? LockKeyhole : noteFormat(entry.name) === 'html' ? FileCode2 : FileText;
      return <li key={entry.path}>
        <div className={`tree-row ${props.selected === entry.path ? 'selected' : ''} ${props.current === entry.path ? 'current' : ''} ${props.draggingPath === entry.path ? 'dragging' : ''} ${folder && props.dropPath === entry.path ? 'drop-target' : ''}`}
          style={{ paddingLeft: 8 + depth * 15 }}
          data-entry-path={entry.path} data-drop-path={folder ? entry.path : undefined}
          draggable={props.canDrag}
          onDragStart={event => props.onDragStart(event, entry.path)} onDragEnd={props.onDragEnd}
          onDragOver={event => props.onDragOver(event, entry.path)}
          onDragLeave={event => { event.stopPropagation(); if (folder) props.onDragLeave(event, entry.path); }}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); if (folder) props.onDrop(event, entry.path); else props.onDragEnd(); }}>
          {folder ? <button className="tree-chevron" aria-label={`${open ? 'Contraer' : 'Expandir'} ${entry.name}`} onClick={() => props.onToggle(entry.path)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="tree-chevron" />}
          <button className="tree-entry" title={entry.path} onClick={() => props.onSelect(entry)} onContextMenu={event => { event.preventDefault(); props.onContext(entry); }}>
            <Icon size={15} /><span>{folder ? entry.name : stripNoteExtension(entry.name)}</span>{!folder && noteFormat(entry.name) === 'html' && <span className="format-badge">HTML</span>}
          </button>
        </div>
        {folder && open && <ul>{render(entry.children ?? [], depth + 1)}</ul>}
      </li>;
    });
  }
  return <ul className="file-tree" aria-label="Archivos de la bóveda">{render(props.entries, 0)}</ul>;
}
