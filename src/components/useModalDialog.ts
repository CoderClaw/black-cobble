import { useEffect, type RefObject } from 'react';

interface Options {
  /** Runs right after the dialog opens, e.g. to focus and select a field. */
  onOpen?: () => void;
  /** Where focus goes when the opener is gone or disabled once the dialog closes. */
  fallback?: () => HTMLElement | null;
}

/**
 * Opens a `<dialog>` as modal on mount. Dialogs are unmounted by React rather than `close()`d, so the browser
 * never restores focus: give it back to the control that opened the dialog, unless something else took it.
 */
export function useModalDialog(element: RefObject<HTMLDialogElement | null>, { onOpen, fallback }: Options = {}) {
  useEffect(() => {
    const dialog = element.current;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body && !dialog?.contains(active) ? active : null;
    dialog?.showModal();
    onOpen?.();
    return () => {
      // Leave the modal state first: nothing outside an open modal dialog can take focus (StrictMode remounts too).
      if (dialog?.open) dialog.close();
      const focused = document.activeElement;
      if (focused && focused !== document.body && !dialog?.contains(focused)) return;
      const target = opener?.isConnected && !opener.matches(':disabled') ? opener : fallback?.();
      target?.focus({ preventScroll: true });
    };
  }, []);
}
