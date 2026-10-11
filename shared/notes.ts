export type NoteFormat = 'md' | 'html';

/** Markdown resolves first: it is the Obsidian-compatible format. */
export const NOTE_FORMATS: readonly NoteFormat[] = ['md', 'html'];
export const NOTE_EXTENSIONS: Record<NoteFormat, string> = { md: '.md', html: '.html' };

/** Largest note file the app opens or saves, in bytes. Encrypted notes hold up to half of it as text. */
export const MAX_NOTE_BYTES = 32 * 1024 * 1024;

export function noteFormat(path: string): NoteFormat | null {
  if (/\.md$/i.test(path)) return 'md';
  if (/\.html$/i.test(path)) return 'html';
  return null;
}

export function isNotePath(path: string): boolean { return noteFormat(path) !== null; }

export function stripNoteExtension(path: string): string { return path.replace(/\.(?:md|html)$/i, ''); }

/** Append the default extension unless the name already names a note format. */
export function withNoteExtension(name: string, format: NoteFormat = 'md'): string {
  return isNotePath(name) ? name : `${name}${NOTE_EXTENSIONS[format]}`;
}

/** Sibling paths that would make a bare wikilink ambiguous, e.g. Nota.md for Nota.html. */
export function counterpartPaths(path: string): string[] {
  const format = noteFormat(path);
  if (!format) return [];
  const stem = stripNoteExtension(path);
  return NOTE_FORMATS.filter(other => other !== format).map(other => `${stem}${NOTE_EXTENSIONS[other]}`);
}

/** Target written for a completed link: Markdown drops .md, HTML notes keep .html so Obsidian still resolves them. */
export function linkTargetFor(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return noteFormat(normalized) === 'md' ? stripNoteExtension(normalized) : normalized;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function initialNoteContent(filename: string): string {
  if (noteFormat(filename) !== 'html') return '';
  const title = escapeHtml(stripNoteExtension(filename.split('/').pop() ?? filename));
  return `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="generator" content="Black Cobble">\n<title>${title}</title>\n</head>\n<body>\n<p></p>\n</body>\n</html>\n`;
}
