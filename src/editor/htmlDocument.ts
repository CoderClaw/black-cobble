export interface HtmlDocumentParts { before: string; body: string; after: string }

/** The visual editor owns only the <body> contents; doctype, head and properties stay byte-for-byte. */
export function splitHtmlDocument(content: string): HtmlDocumentParts {
  const open = /<body\b[^>]*>/i.exec(content);
  const close = content.toLowerCase().lastIndexOf('</body>');
  if (!open || close < open.index + open[0].length) return { before: '', body: content, after: '' };
  const start = open.index + open[0].length;
  return { before: content.slice(0, start), body: content.slice(start, close), after: content.slice(close) };
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
  // Separate adjacent blocks so <h1>a</h1><p>b</p> counts two words.
  const spaced = splitHtmlDocument(content).body.replace(/<\/(?:p|h[1-6]|li|div|td|th|blockquote|pre)>|<br\s*\/?>/gi, '$& ');
  const parsed = new DOMParser().parseFromString(spaced, 'text/html');
  for (const hidden of parsed.querySelectorAll('script, style, template')) hidden.remove();
  return parsed.body.textContent ?? '';
}
