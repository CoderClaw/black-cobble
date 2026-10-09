import { describe, expect, it } from 'vitest';
import type { VaultEntry } from '../shared/types';
import { canMoveEntry, readEntryDrag } from '../src/lib/treeDnd';

const entries: VaultEntry[] = [
  { name: 'Inicio.md', path: 'Inicio.md', type: 'file' },
  { name: 'Proyectos', path: 'Proyectos', type: 'folder', children: [
    { name: 'Idea.md', path: 'Proyectos/Idea.md', type: 'file' },
    { name: 'Subcarpeta', path: 'Proyectos/Subcarpeta', type: 'folder', children: [] },
  ] },
  { name: 'Archivo', path: 'Archivo', type: 'folder', children: [] },
];

describe('tree drag/drop destinations', () => {
  it('moves files and folders into nested folders and back to the root', () => {
    expect(canMoveEntry(entries, 'Inicio.md', 'Proyectos/Subcarpeta')).toBe(true);
    expect(canMoveEntry(entries, 'Archivo', 'Proyectos/Subcarpeta')).toBe(true);
    expect(canMoveEntry(entries, 'Proyectos/Idea.md', '')).toBe(true);
    expect(canMoveEntry(entries, 'Proyectos/Subcarpeta', '')).toBe(true);
  });
  it('rejects self, descendants and same-parent no-op moves', () => {
    expect(canMoveEntry(entries, 'Proyectos', 'Proyectos')).toBe(false);
    expect(canMoveEntry(entries, 'Proyectos', 'Proyectos/Subcarpeta')).toBe(false);
    expect(canMoveEntry(entries, 'Proyectos/Idea.md', 'Proyectos')).toBe(false);
    expect(canMoveEntry(entries, 'Inicio.md', '')).toBe(false);
  });
  it('requires a known source and a real destination folder', () => {
    expect(canMoveEntry(entries, 'externo.md', 'Proyectos')).toBe(false);
    expect(canMoveEntry(entries, 'Inicio.md', 'Desconocida')).toBe(false);
    expect(canMoveEntry(entries, 'Proyectos/Idea.md', 'Inicio.md')).toBe(false);
  });
});

describe('internal drag sessions', () => {
  const session = { path: 'Proyectos/Idea.md', token: 'local-session' };
  it('accepts only the source and token from the current internal drag', () => {
    expect(readEntryDrag(JSON.stringify(session), session)).toBe(session.path);
    expect(readEntryDrag(JSON.stringify(session), null)).toBeNull();
    expect(readEntryDrag(JSON.stringify({ ...session, token: 'external' }), session)).toBeNull();
    expect(readEntryDrag(JSON.stringify({ ...session, path: 'Inicio.md' }), session)).toBeNull();
  });
  it('rejects malformed and external file payloads', () => {
    expect(readEntryDrag('C:\\external.md', session)).toBeNull();
    expect(readEntryDrag('null', session)).toBeNull();
    expect(readEntryDrag('{}', session)).toBeNull();
  });
});
