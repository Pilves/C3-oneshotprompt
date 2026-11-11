// Pure helpers shared by the page and the Node tests: nothing here may touch the DOM.

/**
 * Cuts `text` into plain and highlighted parts at server-supplied [start, end) UTF-16 offsets.
 * Ranges are not trusted: bad ones are dropped, the rest clamped and merged, so the parts
 * always concatenate back to `text` and every character is rendered exactly once.
 * @param {string} text
 * @param {unknown} ranges
 * @returns {{ text: string, hit: boolean }[]}
 */
export function splitByRanges(text, ranges) {
  const clean = [];
  for (const range of Array.isArray(ranges) ? ranges : []) {
    if (!Array.isArray(range) || !Number.isInteger(range[0]) || !Number.isInteger(range[1])) continue;
    const start = Math.max(0, range[0]);
    const end = Math.min(text.length, range[1]);
    if (start < end) clean.push([start, end]);
  }
  clean.sort((a, b) => a[0] - b[0]);

  const parts = [];
  let pos = 0;
  for (const [start, end] of clean) {
    if (end <= pos) continue;
    const from = Math.max(start, pos);
    if (from > pos) parts.push({ text: text.slice(pos, from), hit: false });
    const last = parts.at(-1);
    if (from === pos && last?.hit) last.text += text.slice(from, end);
    else parts.push({ text: text.slice(from, end), hit: true });
    pos = end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
  return parts;
}

/**
 * The link target for a finding's source, or null when it must not be linked.
 * The server already classifies sources; this re-checks the scheme so a wrong or forged
 * `href` can never become a clickable non-web URL.
 * @param {{ href?: unknown } | null | undefined} source
 * @returns {string | null}
 */
export function safeHref(source) {
  const href = source?.href;
  if (typeof href !== 'string') return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // The parsed form, not the input: the browser would resolve some inputs (e.g. "http:host")
  // against the page's own URL instead of the way they were checked here.
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/**
 * Query string for GET /api/findings. Empty values are left out so the server applies its defaults.
 * @param {{ q?: string, types?: string[], case?: string, from?: string, to?: string, dups?: boolean, offset?: number }} state
 * @returns {string}
 */
export function buildSearchQuery(state) {
  return encodeParams([
    ...filterParams(state),
    ['includeDuplicates', state.dups ? 'true' : ''],
    ['offset', state.offset ? String(state.offset) : ''],
  ]);
}

function filterParams(state) {
  return [['q', state.q], ['type', state.types?.join(',')], ['case', state.case], ['from', state.from], ['to', state.to]];
}

function encodeParams(pairs) {
  return pairs
    .filter(([, value]) => value)
    // toWellFormed: encodeURIComponent throws on a lone surrogate, which a pasted query can contain.
    // Commas stay readable; they only ever separate types, and the server decodes them either way.
    .map(([key, value]) => `${key}=${encodeURIComponent(value.toWellFormed()).replaceAll('%2C', ',')}`)
    .join('&');
}
