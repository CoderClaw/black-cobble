import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { MAX_NOTE_BYTES, noteFormat, type NoteFormat } from './notes';

/** Options shared by the global search panel and the main-process scanner. */
export interface SearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs relative to the vault root; empty means every note. */
  include?: string;
  /** Comma-separated globs relative to the vault root. */
  exclude?: string;
}

/** One occurrence. Offsets are UTF-16 indexes into the raw note content (for HTML, always inside visible body text). */
export interface SearchMatch {
  start: number;
  end: number;
  /** 0-based line of `start` in the raw content. */
  line: number;
  /** Visible text around the match, trimmed to a single line. */
  preview: { before: string; text: string; after: string };
}

export interface SearchFileResult { path: string; version: string; matches: SearchMatch[] }

export interface SearchResult {
  files: SearchFileResult[];
  /** True when the scan stopped at the match or file limit. */
  truncated: boolean;
}

/** A file to rewrite. `matches` limits the rewrite to those exact ranges; omitted means every match. */
export interface ReplaceTarget { path: string; version: string; matches?: Array<{ start: number; end: number }> }

export interface ReplaceOutcome {
  path: string;
  status: 'replaced' | 'conflict' | 'error';
  count: number;
  version?: string;
  message?: string;
  /**
   * For 'replaced': the applied edits in ascending order. start/end are the old raw offsets of the replaced
   * source; length is the length of the raw text written there. A whole rewritten HTML text node is one edit.
   */
  edits?: ReplaceEdit[];
}

export interface ReplaceEdit { start: number; end: number; length: number }

export const MAX_SEARCH_MATCHES = 10_000;
export const MAX_QUERY_LENGTH = 1000;
/** A replace request never names more files than a search can return. */
export const MAX_REPLACE_TARGETS = MAX_SEARCH_MATCHES;
const BEFORE = 40;
const AFTER = 160;

type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type TextNode = DefaultTreeAdapterMap['textNode'];
/**
 * One body text node: `map[i]` is the raw offset of decoded index i, or -1 inside a multi-unit decoding;
 * `leading` marks the first text of a <pre>/<listing>, whose first line feed the parser drops.
 */
type Segment = { value: string; map: Int32Array; at: number; start: number; end: number; leading: boolean };
type Hit = { start: number; end: number; match: RegExpExecArray; visible: string; from: number; to: number };

const regexError = (error: unknown) => new Error(`Expresión regular no válida: ${(error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '')}`);

/** Compile the query, or null for an empty one. Invalid patterns throw a Spanish message. */
export function searchPattern(options: SearchOptions): RegExp | null {
  const { query } = options;
  if (typeof query !== 'string' || !query) return null;
  if (query.length > MAX_QUERY_LENGTH) throw new Error('La búsqueda es demasiado larga.');
  // Validate alone first: "x)|(y" must not escape the whole-word wrapper.
  if (options.regex) try { new RegExp(query, 'u'); } catch (error) { throw regexError(error); }
  let source = options.regex ? query : query.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  // \b only knows ASCII: "canción" must be one word.
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}\\p{M}_])(?:${source})(?![\\p{L}\\p{N}\\p{M}_])`;
  try { return new RegExp(source, options.matchCase ? 'gmu' : 'gimu'); }
  catch (error) { throw regexError(error); }
}

function* execAll(pattern: RegExp, value: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (match[0]) yield match;
    else pattern.lastIndex = match.index + ((value.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1);
  }
}

/** Markdown is matched with every line break read as \n, like VS Code: ^, $ and \n never split a CRLF. */
function lineFeeds(content: string): { text: string; raw: (index: number) => number; eol: string } {
  if (!content.includes('\r')) return { text: content, raw: index => index, eol: '\n' };
  // Indexes in `text` of the line feeds that replaced a CRLF, one raw unit shorter each.
  const shifts: number[] = [];
  const text = content.replace(/\r\n?/g, (eol: string, offset: number) => { if (eol.length === 2) shifts.push(offset - shifts.length); return '\n'; });
  let feeds = 0;
  for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) feeds++;
  const raw = (index: number) => {
    let low = 0;
    let high = shifts.length;
    while (low < high) { const middle = (low + high) >> 1; if (shifts[middle] < index) low = middle + 1; else high = middle; }
    return index + low;
  };
  return { text, raw, eol: shifts.length > feeds - shifts.length ? '\r\n' : '\n' };
}

const HIDDEN = new Set(['script', 'style', 'template', 'noscript', 'noembed', 'noframes', 'iframe', 'xmp', 'plaintext', 'textarea', 'select', 'object']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul']);
let entity = '';
const entities = new EntityDecoder(htmlDecodeTree, codePoint => { entity += String.fromCodePoint(codePoint); });
/** Raw length of the character reference at `at` (0 for a bare &); its text is left in `entity`. */
function reference(raw: string, at: number): number {
  entity = '';
  entities.startEntity(DecodingMode.Legacy);
  const size = entities.write(raw, at + 1);
  return size < 0 ? entities.end() : size;
}

/** Split a text node's source into units (characters, CRLF, character references) and check them against the parsed value. */
function sourceMap(content: string, node: TextNode): Int32Array | null {
  const location = node.sourceCodeLocation;
  if (!location) return null;
  const { value } = node;
  const map = new Int32Array(value.length + 1).fill(-1);
  let raw = location.startOffset;
  let at = 0;
  while (raw < location.endOffset) {
    const char = content[raw];
    let size = 1;
    let text = char;
    if (char === '&') { size = reference(content, raw); if (size > 0) text = entity; else size = 1; }
    else if (char === '\r') { size = content[raw + 1] === '\n' ? 2 : 1; text = '\n'; }
    else if (char === '\0' && value[at] !== '\0' && value[at] !== '�') text = '';
    if (raw + size > location.endOffset || !value.startsWith(text, at)) return null;
    if (text) map[at] = raw;
    raw += size;
    at += text.length;
  }
  if (at !== value.length) return null;
  map[at] = raw;
  return map;
}

const special = /[&<\r\0]/g;
/** What the parser reads from raw body text, or null when it would contain markup. */
function decodeText(raw: string): string | null {
  let text = '';
  let at = 0;
  special.lastIndex = 0;
  for (let found = special.exec(raw); found; found = special.exec(raw)) {
    const index = found.index;
    text += raw.slice(at, index);
    const char = raw[index];
    if (char === '\0' || (char === '<' && /[a-z!/?]/i.test(raw[index + 1] ?? ''))) return null;
    const size = char === '&' ? reference(raw, index) : 0;
    if (size > 0) { text += entity; at = index + size; }
    else if (char === '\r') { text += '\n'; at = index + (raw[index + 1] === '\n' ? 2 : 1); }
    else { text += char; at = index + 1; }
    special.lastIndex = at;
  }
  return text + raw.slice(at);
}

/** Visible body text, one line per block, and its text nodes in source order. */
function htmlText(content: string): { visible: string; segments: Segment[] } {
  const document = parse(content, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find(node => node.nodeName === 'html') as Element | undefined;
  const body = html?.childNodes.find(node => node.nodeName === 'body') as Element | undefined;
  const segments: Segment[] = [];
  let visible = '';
  const visit = (node: ParentNode) => {
    node.childNodes.forEach((child, index) => {
      if (child.nodeName === '#text') {
        const text = child as TextNode;
        const map = sourceMap(content, text);
        const location = text.sourceCodeLocation;
        if (map && location && text.value) {
          const leading = index === 0 && 'tagName' in node && (node.tagName === 'pre' || node.tagName === 'listing') && node.sourceCodeLocation?.startTag?.endOffset === location.startOffset;
          segments.push({ value: text.value, map, at: visible.length, start: location.startOffset, end: location.endOffset, leading });
        }
        visible += text.value.replace(/[\r\n]/g, ' ');
      } else if ('tagName' in child && !HIDDEN.has(child.tagName)) {
        const block = BLOCK.has(child.tagName);
        if (block) visible += '\n';
        visit(child);
        if (block) visible += '\n';
      }
    });
  };
  if (body) visit(body);
  // Foster parenting can move table text before its source position.
  return { visible, segments: segments.sort((a, b) => a.start - b.start) };
}

// Matches never cross HTML text nodes: "can<b>ción</b>" is two separate texts.
function* segmentHits(segment: Segment, pattern: RegExp): Generator<{ start: number; end: number; first: number; last: number; match: RegExpExecArray }> {
  for (const match of execAll(pattern, segment.value)) {
    const first = match.index;
    const last = first + match[0].length;
    const start = segment.map[first];
    const end = segment.map[last];
    // Half of an entity that decodes to several characters cannot be rewritten.
    if (start >= 0 && end >= 0) yield { start, end, first, last, match };
  }
}

function* scan(content: string, format: NoteFormat, pattern: RegExp): Generator<Hit> {
  if (format !== 'html') {
    const { text, raw } = lineFeeds(content);
    for (const match of execAll(pattern, text)) {
      const to = match.index + match[0].length;
      yield { start: raw(match.index), end: raw(to), match, visible: text, from: match.index, to };
    }
    return;
  }
  const { visible, segments } = htmlText(content);
  for (const segment of segments) {
    for (const { start, end, first, last, match } of segmentHits(segment, pattern)) yield { start, end, match, visible, from: segment.at + first, to: segment.at + last };
  }
}

const lineBreak = (char: string | undefined) => char === '\n' || char === '\r';
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;

function preview(hit: Hit, html: boolean): SearchMatch['preview'] {
  const { visible, from, to } = hit;
  let start = from;
  while (start > 0 && from - start < BEFORE && !lineBreak(visible[start - 1])) start--;
  const cut = start > 0 && !lineBreak(visible[start - 1]);
  if (cut && low(visible.charCodeAt(start))) start++;
  let textEnd = from;
  while (textEnd < to && textEnd - from < AFTER && !lineBreak(visible[textEnd])) textEnd++;
  let end = textEnd;
  if (textEnd === to) while (end < visible.length && end - to < AFTER && !lineBreak(visible[end])) end++;
  if (end > textEnd && end < visible.length && high(visible.charCodeAt(end - 1))) end--;
  if (textEnd < to && high(visible.charCodeAt(textEnd - 1))) textEnd--;
  const tidy = (text: string) => html ? text.replace(/\s+/g, ' ') : text;
  return { before: `${cut ? '…' : ''}${tidy(visible.slice(start, from)).trimStart()}`, text: tidy(visible.slice(from, textEnd)), after: tidy(visible.slice(textEnd, end)).trimEnd() };
}

/**
 * Occurrences in a note, in source order. Markdown is searched as raw text (line breaks as \n); HTML only in
 * visible body text, where offsets map back to whole source units (an entity like &amp; is one unit).
 */
export function findMatches(content: string, format: NoteFormat, options: SearchOptions, limit = MAX_SEARCH_MATCHES): SearchMatch[] {
  const pattern = searchPattern(options);
  const matches: SearchMatch[] = [];
  if (!pattern || limit <= 0) return matches;
  let line = 0;
  let counted = 0;
  for (const hit of scan(content, format, pattern)) {
    for (; counted < hit.start; counted++) {
      const code = content.charCodeAt(counted);
      if (code === 10 || (code === 13 && content.charCodeAt(counted + 1) !== 10)) line++;
    }
    matches.push({ start: hit.start, end: hit.end, line, preview: preview(hit, format === 'html') });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Regex replacement like VS Code: $$, $&, $0, $1..$99, $<name>, and \n, \t, \\. */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(?:(\$)|(&)|(\d{1,2})|<([^>]*)>)|\\([nt\\])/g, (whole, dollar?: string, all?: string, digits?: string, name?: string, escape?: string) => {
    if (dollar) return '$';
    if (all) return match[0];
    if (digits) {
      if (digits.length === 2 && Number(digits) >= 1 && Number(digits) < match.length) return match[Number(digits)] ?? '';
      const group = Number(digits[0]);
      if (group < match.length) return (match[group] ?? '') + digits.slice(1);
      return whole;
    }
    // As in JavaScript: literal without named groups, empty for an unknown name.
    if (name !== undefined) return match.groups ? (Object.hasOwn(match.groups, name) ? match.groups[name] ?? '' : '') : whole;
    return escape === 'n' ? '\n' : escape === 't' ? '\t' : '\\';
  });
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Rewrite the current matches, optionally only those with these exact offsets (any that no longer exists is a
 * CONFLICT). HTML replacements are inserted as text; Markdown line breaks follow the note's own.
 */
export function applyReplacements(content: string, format: NoteFormat, options: SearchOptions, replacement: string, only?: Array<{ start: number; end: number }>): { content: string; count: number; edits: ReplaceEdit[] } {
  const pattern = searchPattern(options);
  const edits: ReplaceEdit[] = [];
  if (!pattern) return { content, count: 0, edits };
  const selected = only && new Set(only.map(range => `${range.start}:${range.end}`));
  const applied = new Set<string>();
  const take = (start: number, end: number) => {
    const key = `${start}:${end}`;
    if (!selected) return true;
    if (!selected.has(key)) return false;
    applied.add(key);
    return true;
  };
  const parts: string[] = [];
  let size = 0;
  const emit = (text: string) => {
    size += text.length;
    // Every UTF-16 unit takes at least one UTF-8 byte.
    if (size > MAX_NOTE_BYTES) throw new Error(`La nota superaría el tamaño máximo de ${MAX_NOTE_BYTES / 1024 / 1024} MiB.`);
    parts.push(text);
  };
  let last = 0;
  let count = 0;
  if (format !== 'html') {
    const { text, raw, eol } = lineFeeds(content);
    for (const match of execAll(pattern, text)) {
      const start = raw(match.index);
      const end = raw(match.index + match[0].length);
      if (!take(start, end)) continue;
      const value = options.regex ? expandReplacement(replacement, match) : replacement;
      const written = eol === '\n' ? value : value.replace(/\r?\n/g, eol);
      emit(content.slice(last, start));
      emit(written);
      edits.push({ start, end, length: written.length });
      last = end;
      count++;
    }
  } else {
    for (const segment of htmlText(content).segments) {
      let raw = '';
      let value = '';
      let rawAt = segment.start;
      let valueAt = 0;
      let touched = 0;
      const local: ReplaceEdit[] = [];
      for (const hit of segmentHits(segment, pattern)) {
        if (!take(hit.start, hit.end)) continue;
        const text = options.regex ? expandReplacement(replacement, hit.match) : replacement;
        const escaped = escapeText(text);
        local.push({ start: hit.start, end: hit.end, length: escaped.length });
        raw += content.slice(rawAt, hit.start) + escaped;
        value += segment.value.slice(valueAt, hit.first) + text;
        rawAt = hit.end;
        valueAt = hit.last;
        touched++;
      }
      if (!touched) continue;
      raw += content.slice(rawAt, segment.end);
      value += segment.value.slice(valueAt);
      // Edits can join neighbours into a reference or a tag ("&lt" + "imes;"): then write the whole text escaped.
      let whole = false;
      if (decodeText(raw) !== value) { raw = escapeText(value); whole = true; }
      if (segment.leading && value.startsWith('\n')) { raw = `\n${raw}`; whole = true; }
      edits.push(...whole ? [{ start: segment.start, end: segment.end, length: raw.length }] : local);
      emit(content.slice(last, segment.start));
      emit(raw);
      last = segment.end;
      count += touched;
    }
  }
  if (selected && applied.size !== selected.size) throw new Error('CONFLICT: Las coincidencias han cambiado.');
  if (!count) return { content, count, edits };
  emit(content.slice(last));
  return { content: parts.join(''), count, edits };
}

const ONE = 0;
const STAR = 1;
const GLOBSTAR = 2;
const FOLDERS = 3;
type Glob = { tokens: Array<string | number>; anchored: boolean };

function compileGlob(pattern: string): Glob {
  const chars = [...pattern.toLowerCase()];
  const tokens: Array<string | number> = [];
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] === '*') {
      let run = 1;
      while (chars[index + 1] === '*') { index++; run++; }
      if (run === 1) tokens.push(STAR);
      else if (chars[index + 1] === '/') { index++; tokens.push(FOLDERS); }
      else tokens.push(GLOBSTAR);
    } else tokens.push(chars[index] === '?' ? ONE : chars[index]);
  }
  return { tokens, anchored: pattern.includes('/') };
}

/** Linear state-set matching: no backtracking, whatever the pattern. */
function globMatch({ tokens, anchored }: Glob, path: string): boolean {
  const chars = [...path.toLowerCase()];
  const size = tokens.length;
  let states = new Uint8Array(size + 1);
  for (let at = 0; ; at++) {
    if (at === 0 || (!anchored && chars[at - 1] === '/')) states[0] = 1;
    for (let state = 0; state < size; state++) if (states[state] && typeof tokens[state] === 'number' && tokens[state] !== ONE) states[state + 1] = 1;
    if (states[size] && (at === chars.length || chars[at] === '/')) return true;
    if (at === chars.length) return false;
    const char = chars[at];
    const next = new Uint8Array(size + 1);
    for (let state = 0; state < size; state++) {
      if (!states[state]) continue;
      const token = tokens[state];
      if (token === ONE) { if (char !== '/') next[state + 1] = 1; }
      else if (token === STAR) { if (char !== '/') next[state] = 1; }
      else if (token === GLOBSTAR) next[state] = 1;
      else if (token === FOLDERS) { next[state] = 1; if (char === '/') next[state + 1] = 1; }
      else if (token === char) next[state + 1] = 1;
    }
    states = next;
  }
}

/** Comma-separated globs. Without a slash a pattern names any file or folder ("Proyectos", "*.html"); folders include their contents. */
export function globFilter(include = '', exclude = ''): (path: string) => boolean {
  const compile = (value: string) => value.split(',')
    .map(pattern => pattern.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map(compileGlob);
  const included = compile(include);
  const excluded = compile(exclude);
  return path => (!included.length || included.some(glob => globMatch(glob, path))) && !excluded.some(glob => globMatch(glob, path));
}

export function matchesGlobs(path: string, include?: string, exclude?: string): boolean { return globFilter(include, exclude)(path); }

/** Tree order: folders before files at each level, then natural Spanish order. */
export function compareNotePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let index = 0; ; index++) {
    const leftFolder = index < left.length - 1;
    const rightFolder = index < right.length - 1;
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
    const order = left[index].localeCompare(right[index], 'es', { numeric: true, sensitivity: 'base' });
    if (order || !leftFolder) return order;
  }
}

type Loaded = { version: string; content: string } | null;
type Finder = (content: string, format: NoteFormat, options: SearchOptions, limit: number) => SearchMatch[] | Promise<SearchMatch[]>;

/**
 * Scan notes in tree order until the match limit or the deadline (both mark the result truncated);
 * `load` returns null for a note that must be skipped, `find` may run elsewhere.
 */
export async function searchFiles(paths: string[], options: SearchOptions, load: (path: string) => Loaded | Promise<Loaded>, find: Finder = findMatches, deadline = Infinity): Promise<SearchResult> {
  const result: SearchResult = { files: [], truncated: false };
  if (!searchPattern(options)) return result;
  const filter = globFilter(options.include, options.exclude);
  let remaining = MAX_SEARCH_MATCHES;
  for (const path of paths.filter(filter).sort(compareNotePaths)) {
    if (Date.now() > deadline) { result.truncated = true; break; }
    const format = noteFormat(path);
    const note = format && await load(path);
    if (!format || !note) continue;
    const matches = await find(note.content, format, options, remaining + 1);
    if (matches.length > remaining) { result.truncated = true; matches.length = remaining; }
    if (matches.length) result.files.push({ path, version: note.version, matches });
    remaining -= matches.length;
    if (result.truncated) break;
  }
  return result;
}

/** A per-file failure: "CONFLICT:" errors become conflicts, anything else an error. */
export function replaceFailure(path: string, error: unknown): ReplaceOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('CONFLICT:') ? { path, status: 'conflict', count: 0, message: message.slice(9).trim() } : { path, status: 'error', count: 0, message };
}
