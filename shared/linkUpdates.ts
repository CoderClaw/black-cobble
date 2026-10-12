import { parser } from '@lezer/markdown';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { parseWikiLink, resolveWikiLink } from '../src/editor/wikilinks';
import { linkablePath, noteFormat, stripNoteExtension } from './notes';

type Context = { sourceBefore: string; sourceAfter: string; pathsBefore: string[]; pathsAfter: string[]; pathMap: Map<string, string>; keepUnreachable: boolean };
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

/**
 * Keep each existing link's resolved destination across a note or folder move. A destination no link can name
 * (# ^ [ ] | in its path) makes the rewrite throw; with `keepUnreachable` that link is left as written instead, as long
 * as it then reaches no other note.
 */
export function rewriteWikiLinks(
  content: string,
  sourceBefore: string,
  sourceAfter: string,
  pathsBefore: string[],
  pathMap: Map<string, string>,
  { keepUnreachable = false } = {},
): string {
  const context: Context = { sourceBefore, sourceAfter, pathsBefore, pathsAfter: pathsBefore.map(note => pathMap.get(note) ?? note), pathMap, keepUnreachable };
  return noteFormat(sourceBefore) === 'html' ? rewriteHtml(content, context) : rewriteMarkdown(content, context);
}

/** The new [[...]] contents, or null when the link still reaches its destination. */
function relink(inner: string, context: Context): string | null {
  // A heading-only link ([[#Parte]]) always means the document it is written in.
  if (!parseWikiLink(inner).path) return null;
  const before = resolveWikiLink(inner, context.sourceBefore, context.pathsBefore);
  if (!before) return null;
  const intended = context.pathMap.get(before) ?? before;
  if (resolveWikiLink(inner, context.sourceAfter, context.pathsAfter) === intended) return null;
  // A table's \| leaves its backslash on the path: drop it so an explicit .html keeps its preference.
  const originalPath = parseWikiLink(inner).path.replace(/[\s\\]+$/, '');
  const separator = inner.search(/[#|]/);
  const pathEnd = separator < 0 ? inner.length : separator;
  const pathPart = inner.slice(0, pathEnd);
  const leading = pathPart.match(/^\s*/)?.[0] ?? '';
  // Inside a Markdown table the alias pipe is escaped as \|: keep that backslash, which belongs to the table. Spaces
  // before it still belong to the old name, so only those after it are kept.
  const trailing = pathPart.match(inner[pathEnd] === '|' ? /\\*\s*$/ : /\s*$/)?.[0] ?? '';
  const link = (target: string) => `${leading}${target}${trailing}${inner.slice(pathEnd)}`;
  // A leading slash forces root notes to resolve as paths instead of sibling names.
  let replacement = intended.includes('/') ? intended : `/${intended}`;
  if (!noteFormat(originalPath)) replacement = stripNoteExtension(replacement);
  if (linkablePath(intended)) return link(replacement);
  // No path can name that destination, but its bare name still can, with or without extension, when the link as
  // written (escape included) reaches only that note.
  const names = [...new Set([replacement.split('/').pop()!, intended.split('/').pop()!])].filter(linkablePath);
  const reachable = names.map(link).find(candidate => resolveWikiLink(candidate, context.sourceAfter, context.pathsAfter) === intended);
  if (reachable !== undefined) return reachable;
  // Kept as written only while it then reaches no note: it must never quietly point somewhere else.
  if (context.keepUnreachable && !resolveWikiLink(inner, context.sourceAfter, context.pathsAfter)) return null;
  // Refuse before anything is written instead of leaving a broken or redirected link.
  throw new Error(`No se puede actualizar el enlace a «${intended}»: su ruta contiene # ^ [ ] |, que los enlaces no admiten. Cambia ese nombre primero.`);
}

function rewriteMarkdown(content: string, context: Context): string {
  const code: { from: number; to: number }[] = [];
  parser.parse(content).iterate({ enter(node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
      code.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  let codeIndex = 0;
  return content.replace(/\[\[([^\]\r\n]+)\]\]/g, (whole: string, inner: string, offset: number) => {
    while (codeIndex < code.length && code[codeIndex].to <= offset) codeIndex++;
    if (code[codeIndex] && code[codeIndex].from < offset + whole.length) return whole;
    let slashes = 0;
    for (let at = offset - 1; at >= 0 && content[at] === '\\'; at--) slashes++;
    if (slashes % 2) return whole;
    const replacement = relink(inner, context);
    return replacement === null ? whole : `[[${replacement}]]`;
  });
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Rewrite only the data-wikilink attributes, leaving every other byte of the file untouched. */
function rewriteHtml(content: string, context: Context): string {
  const edits: { from: number; to: number; text: string }[] = [];
  const visit = (node: ParentNode) => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      const element = child as Element;
      const attribute = element.tagName === 'a' ? element.attrs.find(item => item.name === 'data-wikilink') : undefined;
      const location = element.sourceCodeLocation?.attrs?.['data-wikilink'];
      if (attribute && location) {
        const replacement = relink(attribute.value, context);
        if (replacement !== null) edits.push({ from: location.startOffset, to: location.endOffset, text: `data-wikilink="${escapeAttribute(replacement)}"` });
      }
      visit(element.tagName === 'template' ? (element as DefaultTreeAdapterMap['template']).content : element);
    }
  };
  visit(parse(content, { sourceCodeLocationInfo: true }));
  let result = content;
  for (const edit of edits.sort((a, b) => b.from - a.from)) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  return result;
}
