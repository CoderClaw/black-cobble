import { useEffect, useRef, useState } from 'react';

export type PasswordMode = 'setup' | 'unlock' | 'change';
interface Props { mode: PasswordMode; busy: boolean; error: string; onCancel: () => void; onSubmit: (password: string, currentPassword: string) => Promise<void> }
export default function PrivatePasswordDialog({ mode, busy, error, onCancel, onSubmit }: Props) {
  const element = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [current, setCurrent] = useState('');
  const [validation, setValidation] = useState('');
  const title = mode === 'setup' ? 'Crear contraseña' : mode === 'change' ? 'Cambiar contraseña' : 'Desbloquear bóveda';
  useEffect(() => { element.current?.showModal(); }, []);
  return <dialog ref={element} className="entry-dialog private-password-dialog" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (mode !== 'unlock' && password !== confirmation) { setValidation('Las contraseñas no coinciden.'); return; }
      const submitted = password; const previous = current;
      setPassword(''); setConfirmation(''); setCurrent(''); setValidation('');
      void onSubmit(submitted, previous);
    }}>
      <h2>{title}</h2>
      {mode === 'setup' && <p>Esta contraseña abre la bóveda privada. No se puede recuperar si la olvidas.</p>}
      {mode === 'change' && <label>Contraseña actual<input type="password" value={current} required disabled={busy} autoFocus autoComplete="off" onChange={event => setCurrent(event.target.value)} /></label>}
      <label>{mode === 'change' ? 'Nueva contraseña' : 'Contraseña'}<input type="password" value={password} required disabled={busy} autoFocus={mode !== 'change'} autoComplete="off" onChange={event => setPassword(event.target.value)} /></label>
      {mode !== 'unlock' && <label>Confirmar contraseña<input type="password" value={confirmation} required disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>}
      {(validation || error) && <p className="dialog-error" role="alert">{validation || error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onCancel}>Cancelar</button><button type="submit" className="primary-button" disabled={busy || !password || (mode !== 'unlock' && !confirmation) || (mode === 'change' && !current)}>{busy ? 'Espera…' : title}</button></div>
    </form>
  </dialog>;
}
