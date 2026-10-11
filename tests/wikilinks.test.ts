import { describe, expect, it } from 'vitest';
import { parseWikiLink, resolveWikiLink, wikiLinkLabelRange, wikiTargetFor } from '../src/editor/wikilinks';

describe('wiki link parsing', () => {
  it('extracts path, heading, and alias without losing spaces', () => {
    expect(parseWikiLink('[[ proyectos/Plan # Próximos pasos | Mi plan ]]')).toEqual({ path: 'proyectos/Plan', heading: 'Próximos pasos', alias: 'Mi plan' });
    expect(parseWikiLink('Nota')).toEqual({ path: 'Nota', heading: '', alias: '' });
    expect(parseWikiLink('#Introducción')).toEqual({ path: '', heading: 'Introducción', alias: '' });
  });
});

describe('wiki link display labels', () => {
  it.each([
    ['programacion/js', 'js'],
    ['programacion/js.md', 'js'],
    ['programacion/js.MD#Funciones', 'js'],
    ['programacion\\js.md', 'js'],
    [' programacion/js.md # Funciones ', 'js'],
    ['programacion/js|JavaScript', 'JavaScript'],
    ['programacion/js|  Mi alias  ', 'Mi alias'],
    ['programacion/js.md#Funciones|', 'js'],
    ['programacion/js.md#Funciones|   ', 'js'],
    ['# Mi encabezado ', 'Mi encabezado'],
    ['# Mi encabezado| ', 'Mi encabezado'],
    ['programacion/js/', 'js'],
  ])('shows %s as %s', (target, expected) => {
    const range = wikiLinkLabelRange(target);
    expect(target.slice(range.from, range.to)).toBe(expected);
  });
});

describe('wiki link resolution', () => {
  const paths = ['Inicio.md', 'Plan.md', 'trabajo/Plan.md', 'archivo/Plan.md', 'trabajo/Ideas nuevas.md'];
  it('favors a sibling when the basename is ambiguous', () => {
    expect(resolveWikiLink('Plan#Resumen|Ver plan', 'trabajo/Actual.md', paths)).toBe('trabajo/Plan.md');
    expect(resolveWikiLink('Plan', 'Actual.md', paths)).toBe('Plan.md');
  });
  it('resolves vault paths, explicit relative paths, case and extensions', () => {
    expect(resolveWikiLink('archivo/plan.MD', 'trabajo/Actual.md', paths)).toBe('archivo/Plan.md');
    expect(resolveWikiLink('../Inicio', 'trabajo/Actual.md', paths)).toBe('Inicio.md');
    expect(resolveWikiLink('./Ideas nuevas', 'trabajo/Actual.md', paths)).toBe('trabajo/Ideas nuevas.md');
    expect(resolveWikiLink('trabajo\\Plan', 'Inicio.md', paths)).toBe('trabajo/Plan.md');
  });
  it('resolves heading-only destinations within the current note', () => {
    expect(resolveWikiLink('#Detalles', 'Inicio.md', paths)).toBe('Inicio.md');
  });
  it('returns null for missing notes and paths outside the vault', () => {
    expect(resolveWikiLink('Nuevo', 'Inicio.md', paths)).toBeNull();
    expect(resolveWikiLink('../../Inicio', 'trabajo/Actual.md', paths)).toBeNull();
    expect(resolveWikiLink('', 'Inicio.md', paths)).toBeNull();
  });
  it('uses a deterministic fallback for duplicate basenames', () => {
    const duplicates = ['z/Idea.md', 'a/Idea.md'];
    expect(resolveWikiLink('Idea', 'otra/Actual.md', duplicates)).toBe('a/Idea.md');
    expect(resolveWikiLink('Idea', 'otra/Actual.md', [...duplicates].reverse())).toBe('a/Idea.md');
  });
});

describe('case-variant duplicates (case-sensitive filesystems)', () => {
  const permutations = <T,>(items: T[]): T[][] => items.length < 2 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
  const resolves = (target: string, from: string, paths: string[], expected: string | null) => {
    for (const order of permutations(paths)) expect(resolveWikiLink(target, from, order), order.join(',')).toBe(expected);
  };

  it('prefers the exact-case bare name regardless of candidate order', () => {
    const paths = ['Nota.md', 'nota.md'];
    resolves('Nota', 'Inicio.md', paths, 'Nota.md');
    resolves('nota', 'Inicio.md', paths, 'nota.md');
    resolves('Nota.md', 'Inicio.md', paths, 'Nota.md');
    resolves('nota.md', 'Inicio.md', paths, 'nota.md');
  });

  it('falls back to a case-insensitive match when no exact one exists', () => {
    resolves('nota', 'Inicio.md', ['Nota.md'], 'Nota.md');
    resolves('NOTA', 'Inicio.md', ['Nota.md', 'nota.md'], 'nota.md');
  });

  it('prefers the exact-case folder path', () => {
    const paths = ['Carpeta/Nota.md', 'carpeta/nota.md', 'Carpeta/nota.md'];
    resolves('Carpeta/Nota', 'Inicio.md', paths, 'Carpeta/Nota.md');
    resolves('carpeta/nota', 'Inicio.md', paths, 'carpeta/nota.md');
    resolves('Carpeta/nota', 'Inicio.md', paths, 'Carpeta/nota.md');
    resolves('CARPETA/NOTA', 'Inicio.md', ['Carpeta/Nota.md', 'carpeta/nota.md'], 'carpeta/nota.md');
  });

  it('prefers the exact-case sibling, keeps step order, and handles explicit relative links', () => {
    const paths = ['sub/Nota.md', 'sub/nota.md', 'Nota.md'];
    resolves('Nota', 'sub/Actual.md', paths, 'sub/Nota.md');
    resolves('nota', 'sub/Actual.md', paths, 'sub/nota.md');
    resolves('./nota', 'sub/Actual.md', paths, 'sub/nota.md');
    resolves('../Nota', 'sub/Actual.md', paths, 'Nota.md');
    // A case-insensitive sibling still beats an exact-case root note.
    resolves('Nota', 'sub/Actual.md', ['sub/nota.md', 'Nota.md'], 'sub/nota.md');
    // Paths with a folder check the root path first, then the sibling folder.
    resolves('x/Nota', 'sub/Actual.md', ['sub/x/Nota.md', 'sub/x/nota.md'], 'sub/x/Nota.md');
    resolves('x/nota', 'sub/Actual.md', ['sub/x/Nota.md', 'sub/x/nota.md'], 'sub/x/nota.md');
  });

  it('prefers the exact-case basename in the fallback', () => {
    resolves('Nota', 'Inicio.md', ['A/Nota.md', 'B/nota.md', 'C/Nota.md'], 'A/Nota.md');
    resolves('nota', 'Inicio.md', ['A/Nota.md', 'B/nota.md', 'C/Nota.md'], 'B/nota.md');
    resolves('NOTA', 'Inicio.md', ['B/nota.md', 'A/Nota.md'], 'A/Nota.md');
  });

  it('keeps Markdown ahead of HTML, matching case exactly within each format', () => {
    resolves('Nota', 'Inicio.md', ['nota.md', 'Nota.html'], 'nota.md');
    resolves('Nota', 'Inicio.md', ['Nota.md', 'nota.md', 'Nota.html'], 'Nota.md');
    resolves('Nota', 'Inicio.md', ['nota.html', 'Nota.html'], 'Nota.html');
  });

  it('round-trips targets written for each variant', () => {
    const paths = ['Nota.md', 'nota.md', 'Carpeta/Nota.md', 'carpeta/nota.md', 'Carpeta/Otra.md'];
    expect(wikiTargetFor('nota.md', 'Inicio.md', paths)).toBe('nota');
    expect(wikiTargetFor('Nota.md', 'Inicio.md', paths)).toBe('Nota');
    for (const source of ['Inicio.md', 'Carpeta/Actual.md', 'carpeta/actual.md'])
      for (const order of permutations(paths))
        for (const note of paths) expect(resolveWikiLink(wikiTargetFor(note, source, order), source, order), `${note} from ${source}`).toBe(note);
  });
});
