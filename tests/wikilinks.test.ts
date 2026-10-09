import { describe, expect, it } from 'vitest';
import { parseWikiLink, resolveWikiLink, wikiLinkLabelRange } from '../src/editor/wikilinks';

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
