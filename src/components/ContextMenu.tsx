import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

interface Props { x: number; y: number; label: string; onClose: () => void; children: ReactNode }
const MARGIN = 6;
export default function ContextMenu({ x, y, label, onClose, children }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  // Escape and Tab hand focus back to where it was, so keyboard users keep their place in the tree.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const dismiss = () => { onClose(); opener.current?.focus({ preventScroll: true }); };
  const items = () => [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []];
  // Clamp inside the viewport once the real size is known, then focus the first item.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: Math.max(MARGIN, Math.min(x, window.innerWidth - box.width - MARGIN)), top: Math.max(MARGIN, Math.min(y, window.innerHeight - box.height - MARGIN)) });
    items()[0]?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  function keydown(event: KeyboardEvent) {
    const list = items(); const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') list[(index + 1) % list.length]?.focus();
    else if (event.key === 'ArrowUp') list[(index <= 0 ? list.length : index) - 1]?.focus();
    else if (event.key === 'Home') list[0]?.focus();
    else if (event.key === 'End') list.at(-1)?.focus();
    else if (event.key === 'Tab') dismiss();
    else return;
    event.preventDefault();
  }
  return <div ref={menu} role="menu" aria-label={label} className="entry-menu context-menu" style={position} onKeyDown={keydown}
    onContextMenu={event => event.preventDefault()}
    onClick={event => { if ((event.target as HTMLElement).closest('[role="menuitem"]')) onClose(); }}>{children}</div>;
}
