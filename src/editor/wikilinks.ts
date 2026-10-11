import { NOTE_EXTENSIONS, NOTE_FORMATS, isNotePath, linkTargetFor } from '../../shared/notes';

export interface WikiLink {
  path: string;
  heading: string;
  alias: string;
}

export function parseWikiLink(target: string): WikiLink {
  const raw = target.replace(/^\[\[/, '').replace(/\]\]$/, '');
  const separator = raw.indexOf('|');
  const destination = separator < 0 ? raw : raw.slice(0, separator);
  const hash = destination.indexOf('#');
  return {
    path: (hash < 0 ? destination : destination.slice(0, hash)).trim(),
    heading: hash < 0 ? '' : destination.slice(hash + 1).trim(),
    alias: separator < 0 ? '' : raw.slice(separator + 1).trim(),
  };
}

export const headingKey = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

/** Visible label offsets inside the raw content between [[ and ]]. */
export function wikiLinkLabelRange(target: string): { from: number; to: number } {
  const trim = (from: number, to: number) => {
    while (from < to && /\s/.test(target[from])) from++;
    while (to > from && /\s/.test(target[to - 1])) to--;
    return { from, to };
  };
  const pipe = target.indexOf('|');
  if (pipe >= 0) {
    const alias = trim(pipe + 1, target.length);
    if (alias.from < alias.to) return alias;
  }
  const destinationEnd = pipe < 0 ? target.length : pipe;
  const hash = target.slice(0, destinationEnd).indexOf('#');
  const path = trim(0, hash < 0 ? destinationEnd : hash);
  while (path.to > path.from && /[\\/]/.test(target[path.to - 1])) path.to--;
  const basenameFrom = Math.max(path.from, target.lastIndexOf('/', path.to - 1) + 1, target.lastIndexOf('\\', path.to - 1) + 1);
  const basename = trim(basenameFrom, path.to);
  if (basename.from < basename.to) {
    const extension = /\.(?:md|html)$/i.exec(target.slice(basename.from, basename.to));
    if (extension && basename.to - basename.from > extension[0].length) basename.to -= extension[0].length;
    return basename;
  }
  if (hash >= 0) {
    const heading = trim(hash + 1, destinationEnd);
    if (heading.from < heading.to) return heading;
  }
  // Invalid empty destinations still leave some text available to select and edit.
  return trim(0, target.length);
}

function normalizePath(path: string): string | null {
  const result: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!result.length) return null;
      result.pop();
    } else result.push(part);
  }
  return result.join('/');
}

/** Resolve only against known notes. Returned paths retain their original case. */
export function resolveWikiLink(target: string, currentPath: string, notePaths: string[]): string | null {
  const parsed = parseWikiLink(target);
  if (!parsed.path) return parsed.heading ? currentPath : null;
  const raw = parsed.path.replace(/\\/g, '/');
  const folder = currentPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const explicitRelative = raw.startsWith('./') || raw.startsWith('../');
  const normalized = normalizePath(explicitRelative ? `${folder}/${raw}` : raw);
  if (!normalized) return null;
  // Bare names try Markdown first. A vault never holds both Nota.md and Nota.html in one folder.
  const destinations = isNotePath(normalized) ? [normalized] : NOTE_FORMATS.map(format => `${normalized}${NOTE_EXTENSIONS[format]}`);
  const notes = [...notePaths].sort((a, b) => a.localeCompare(b, 'en') || (a < b ? -1 : 1));
  // Per destination (format order): a candidate matching with exact case wins, else the first case-insensitive one (Linux vaults may hold Nota.md and nota.md).
  const pick = (wanted: string, key: (note: string) => string | undefined) => {
    const folded = wanted.toLocaleLowerCase();
    let fallback: string | null = null;
    for (const note of notes) {
      const name = key(note);
      if (name === wanted) return note;
      if (!fallback && name?.toLocaleLowerCase() === folded) fallback = note;
    }
    return fallback;
  };
  const find = (prefix: string) => {
    for (const destination of destinations) {
      const note = pick(`${prefix}${destination}`, candidate => candidate.replace(/\\/g, '/'));
      if (note) return note;
    }
    return null;
  };
  const sibling = folder ? `${folder}/` : '';
  if (explicitRelative) return find('');
  // A bare name favors its sibling; explicit vault paths favor the root path.
  if (!raw.includes('/')) {
    const found = find(sibling);
    if (found) return found;
  }
  const exact = find('');
  if (exact) return exact;
  if (raw.includes('/')) return find(sibling);
  for (const destination of destinations) {
    const note = pick(destination, candidate => candidate.replace(/\\/g, '/').split('/').pop());
    if (note) return note;
  }
  return null;
}

/** Target written for a chosen note: the short form when it reaches that note from here, else a vault path. */
export function wikiTargetFor(path: string, currentPath: string, notePaths: string[]): string {
  const short = linkTargetFor(path);
  if (resolveWikiLink(short, currentPath, notePaths) === path) return short;
  // A leading slash forces root notes to resolve as paths instead of sibling names.
  return short.includes('/') ? short : `/${short}`;
}
