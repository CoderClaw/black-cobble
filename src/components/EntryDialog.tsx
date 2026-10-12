import { useId, useRef, useState } from 'react';
import { isNotePath, type NoteFormat } from '../../shared/notes';
import { useModalDialog } from './useModalDialog';

const FORMAT_KEY = 'boveda.noteFormat';
const rememberedFormat = (): NoteFormat => { try { return localStorage.getItem(FORMAT_KEY) === 'html' ? 'html' : 'md'; } catch { return 'md'; } };

export interface DialogSpec {
  kind: 'note' | 'folder' | 'rename' | 'move' | 'trash' | 'missing';
  title: string;
  path: string;
  initialValue?: string;
  folders?: string[];
  heading?: string;
  permanent?: boolean;
}
interface Props { spec: DialogSpec; busy: boolean; error: string; onCancel: () => void; onSubmit: (value: string, format: NoteFormat) => void }
export default function EntryDialog({ spec, busy, error, onCancel, onSubmit }: Props) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(spec.initialValue ?? '');
  const [format, setFormat] = useState<NoteFormat>(rememberedFormat);
  useModalDialog(element, { onOpen: () => { input.current?.focus(); input.current?.select(); } });
  const deleting = spec.kind === 'trash';
  const missing = spec.kind === 'missing';
  const described = deleting || missing;
  return <dialog ref={element} className="entry-dialog" aria-labelledby={titleId} aria-describedby={described ? descriptionId : undefined} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (spec.kind === 'note') { try { localStorage.setItem(FORMAT_KEY, format); } catch { /* Preferences are optional. */ } }
      onSubmit(value.trim(), format);
    }}>
      <h2 id={titleId}>{spec.title}</h2>
      {deleting ? <p id={descriptionId}>{spec.permanent ? `Se eliminará "${spec.path}" permanentemente${isNotePath(spec.path) ? '.' : ' junto con su contenido.'} No se puede recuperar.` : `Se enviará "${spec.path}" a la papelera${isNotePath(spec.path) ? '.' : ' junto con su contenido.'}`}</p> : missing ? <p id={descriptionId}>Crear «{spec.path}»{spec.path.includes('/') ? ' y las carpetas que falten' : ''}.</p> : spec.kind === 'move' ? <label>Carpeta de destino<select autoFocus value={value} disabled={busy} onChange={event => setValue(event.target.value)}>{spec.folders?.map(folder => <option key={folder} value={folder}>{folder || 'Raíz de la bóveda'}</option>)}</select></label> : <label>Nombre<input ref={input} value={value} disabled={busy} onChange={event => setValue(event.target.value)} required autoComplete="off" placeholder={spec.kind === 'note' ? 'Nueva nota' : undefined} /></label>}
      {spec.kind === 'note' && <div className="format-choice" role="radiogroup" aria-label="Formato"
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          // Focus follows the selection, as in a native radio group.
          event.preventDefault();
          const next = format === 'md' ? 'html' : 'md';
          setFormat(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-format="${next}"]`)?.focus();
        }}>
        {([['md', 'Markdown', 'Compatible con Obsidian'], ['html', 'HTML', 'Editor visual, tablas y formato rico']] as const).map(([option, label, detail]) =>
          <button key={option} type="button" role="radio" data-format={option} aria-checked={format === option} tabIndex={format === option ? 0 : -1} disabled={busy} onClick={() => setFormat(option)}><strong>{label}</strong><small>{detail}</small></button>)}
      </div>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onCancel}>Cancelar</button><button type="submit" className={deleting ? 'danger-button' : 'primary-button'} disabled={busy || (!deleting && !missing && spec.kind !== 'move' && !value.trim())}>{busy ? 'Espera…' : deleting ? spec.permanent ? 'Eliminar permanentemente' : 'Enviar a la papelera' : spec.kind === 'rename' ? 'Renombrar' : spec.kind === 'move' ? 'Mover' : 'Crear'}</button></div>
    </form>
  </dialog>;
}
