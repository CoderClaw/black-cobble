import type { SearchMatch } from '../../shared/search';

/** CodeMirror stores line breaks as "\n": a raw offset loses one unit per earlier "\r\n". */
export function editorOffset(content: string, offset: number): number {
  let shift = 0;
  for (let index = content.indexOf('\r\n'); index !== -1 && index < offset - 1; index = content.indexOf('\r\n', index + 2)) shift++;
  return offset - shift;
}

/** Find a match again in text that changed since the search: its text nearest to where its line was. */
export function relocateMatch(content: string, match: SearchMatch): { from: number; to: number } {
  const text = content.replace(/\r\n?/g, '\n');
  let lineStart = 0;
  for (let line = 0; line < match.line && lineStart < text.length; line++) {
    const next = text.indexOf('\n', lineStart);
    lineStart = next === -1 ? text.length : next + 1;
  }
  const anchor = Math.min(text.length, lineStart + match.preview.before.replace(/^…/, '').length);
  const needle = match.preview.text;
  let best = -1;
  if (needle) for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    if (best === -1 || Math.abs(index - anchor) < Math.abs(best - anchor)) best = index;
    if (index > anchor) break;
  }
  return best === -1 ? { from: anchor, to: anchor } : { from: best, to: best + needle.length };
}
