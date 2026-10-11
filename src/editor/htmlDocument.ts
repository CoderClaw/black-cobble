import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Element = DefaultTreeAdapterMap['element'];
export interface HtmlDocumentParts { before: string; body: string; after: string }

/**
 * The visual editor owns only the <body> contents; doctype, head and properties stay byte-for-byte.
 * The parser finds the real body, so "<body>" inside a comment, script or attribute is never taken for it.
 */
export function splitHtmlDocument(content: string): HtmlDocumentParts {
  const document = parse(content, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find((node): node is Element => node.nodeName === 'html');
  const body = html?.childNodes.find((node): node is Element => node.nodeName === 'body');
  if (!html || !body) return { before: '', body: content, after: '' };
  const end = body.sourceCodeLocation?.endTag?.startOffset ?? html.sourceCodeLocation?.endTag?.startOffset ?? content.length;
  // Without a <body> tag the body starts at its first parsed child, so a leading head (title, comments) stays outside.
  const first = Math.min(...body.childNodes.map(node => node.sourceCodeLocation?.startOffset ?? end));
  const start = Math.min(body.sourceCodeLocation?.startTag?.endOffset ?? first, end);
  return { before: content.slice(0, start), body: content.slice(start, end), after: content.slice(end) };
}

export function joinHtmlDocument(parts: HtmlDocumentParts, body: string): string {
  return parts.before || parts.after ? `${parts.before}\n${body}\n${parts.after}` : body;
}

/**
 * One block per line keeps diffs readable and makes repeated saves deterministic.
 * Only whitespace between block elements is added, which HTML parsers ignore.
 */
export function formatHtmlBlocks(html: string): string {
  return html
    .replace(/(<\/(?:p|h[1-6]|li|ul|ol|blockquote|pre|table|thead|tbody|tr|div)>|<hr>)(?!\n)/g, '$1\n')
    .replace(/(<(?:ul|ol|table|thead|tbody|tr|blockquote)(?:\s[^>]*)?>)(?!\n)/g, '$1\n')
    .trimEnd();
}

/** Visible text for counters and search, parsed inertly: no scripts run and no resources load. */
export function htmlText(content: string): string {
  // Separate adjacent blocks so <h1>a</h1><p>b</p> counts two words. The parsed body leaves the head out.
  const spaced = content.replace(/<\/(?:p|h[1-6]|li|div|td|th|blockquote|pre)>|<br\s*\/?>/gi, '$& ');
  const parsed = new DOMParser().parseFromString(spaced, 'text/html');
  for (const hidden of parsed.querySelectorAll('script, style, template')) hidden.remove();
  return parsed.body.textContent ?? '';
}
