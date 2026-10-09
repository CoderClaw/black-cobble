import type { VaultEntry } from '../../shared/types';
import { flattenEntries, isWithin, parentPath } from './paths';

export const ENTRY_DRAG_TYPE = 'application/x-boveda-entry';
export interface EntryDragSession { path: string; token: string }

/** Only a drag started in this window may request a filesystem move. */
export function readEntryDrag(payload: string, session: EntryDragSession | null): string | null {
  if (!session) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== 'object') return null;
    const drag = value as Partial<EntryDragSession>;
    return drag.path === session.path && drag.token === session.token ? session.path : null;
  } catch { return null; }
}

export function canMoveEntry(entries: VaultEntry[], path: string, destination: string): boolean {
  const all = flattenEntries(entries);
  const entry = all.find(item => item.path === path);
  if (!entry || parentPath(path) === destination) return false;
  if (destination && !all.some(item => item.path === destination && item.type === 'folder')) return false;
  return entry.type !== 'folder' || !isWithin(destination, path);
}
