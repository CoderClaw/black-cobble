import type { VaultEntry } from '../../shared/types';

export function flattenEntries(entries: VaultEntry[]): VaultEntry[] {
  return entries.flatMap(entry => [entry, ...flattenEntries(entry.children ?? [])]);
}
export function parentPath(path: string): string { return path.split('/').slice(0, -1).join('/'); }
export function baseName(path: string): string { return path.split('/').pop() ?? ''; }
export function isWithin(path: string, parent: string): boolean { return path === parent || path.startsWith(`${parent}/`); }
export function replacePrefix(path: string, oldPath: string, newPath: string): string {
  return isWithin(path, oldPath) ? newPath + path.slice(oldPath.length) : path;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
}
