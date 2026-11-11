import { isIP } from 'node:net';

export const FLAGS = [
  'id_missing',
  'duplicate_id',
  'reingested_duplicate',
  'entity_missing',
  'type_mismatch',
  'case_missing',
  'case_invalid',
  'multi_case',
  'time_invalid',
  'source_missing',
  'source_unsafe',
  'source_scheme_assumed',
  'source_invalid',
  'notes_missing',
  'notes_markup',
  'notes_instruction_like',
];

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const EMAIL = /^[^\s@]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i;
const CASE_ID = /^C-\d+$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const HTTP_URL = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_AND_PORT = /^[a-z0-9.-]+\.[a-z]{2,}:\d+(\/|$)/i;
const SCHEMELESS_URL = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const LABEL_SYNONYMS = { ipv4: 'ip', ipv6: 'ip' };
// Types that have no checkable syntax, so the label is the only evidence and is trusted.
const LABEL_ONLY_TYPES = ['handle', 'alias', 'wallet'];

/**
 * The type a value provably has from its syntax alone. Handles and aliases have no syntax, and
 * only EVM wallets are recognised.
 * @param {string} entity already trimmed
 * @returns {'wallet' | 'ip' | 'email' | 'domain' | null}
 */
export function detectShape(entity) {
  if (WALLET.test(entity)) return 'wallet';
  if (isIP(entity) !== 0) return 'ip';
  if (EMAIL.test(entity)) return 'email';
  if (DOMAIN.test(entity) && entity.length <= 253) return 'domain';
  return null;
}

/**
 * The value's shape wins over the label, so that filtering by type finds every IP, email, etc.
 * The disagreement is reported, not hidden.
 * @param {string} typeRaw the label as collected ('' if absent)
 * @param {string} entity already trimmed
 * @returns {{ type: string, mismatch: boolean }}
 */
export function normalizeType(typeRaw, entity) {
  if (entity === '') return { type: 'unknown', mismatch: false };
  const trimmed = typeRaw.trim().toLowerCase();
  const label = LABEL_SYNONYMS[trimmed] ?? trimmed;
  const shape = detectShape(entity);
  if (shape !== null) return { type: shape, mismatch: label !== shape };
  if (LABEL_ONLY_TYPES.includes(label)) return { type: label, mismatch: false };
  return { type: 'unknown', mismatch: label !== 'unknown' };
}

/**
 * @param {unknown} value the record's caseId: a string, an array of them, or null
 * @returns {{ caseIds: string[], flags: string[] }}
 */
export function normalizeCaseIds(value) {
  if (value === null || value === undefined) return { caseIds: [], flags: ['case_missing'] };
  const valid = new Set();
  let invalid = false;
  for (const candidate of Array.isArray(value) ? value : [value]) {
    const caseId = typeof candidate === 'string' ? candidate.trim().toUpperCase() : '';
    if (CASE_ID.test(caseId)) valid.add(caseId);
    else invalid = true;
  }
  const flags = [];
  if (valid.size === 0) flags.push('case_missing');
  if (invalid) flags.push('case_invalid');
  if (valid.size > 1) flags.push('multi_case');
  return { caseIds: [...valid].sort(compareCaseIds), flags };
}

function compareCaseIds(a, b) {
  return Number(a.slice(2)) - Number(b.slice(2)) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Epoch numbers are milliseconds; values below 1e11 can only be seconds (1e11 ms is in 1973).
 * @param {unknown} value
 * @returns {{ iso: string|null, ms: number|null, flags: string[] }}
 */
export function normalizeObservedAt(value) {
  let ms = NaN;
  if (typeof value === 'number') {
    ms = epochMs(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d+$/.test(text)) ms = epochMs(Number(text));
    else if (isValidIsoDateTime(text)) ms = Date.parse(text);
  }
  // The Date constructor drops fractions of a millisecond and rejects instants outside its range.
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return { iso: null, ms: null, flags: ['time_invalid'] };
  return { iso: date.toISOString(), ms: date.getTime(), flags: [] };
}

function epochMs(n) {
  return n < 1e11 ? n * 1000 : n;
}

/** Date.parse rolls 2026-02-30 over to March and accepts 24:00, so the fields are checked first. */
function isValidIsoDateTime(text) {
  const m = ISO_DATE_TIME.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s, oh, om] = m.slice(1).map((group) => Number(group ?? 0));
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth && h <= 23 && mi <= 59 && s <= 59 && oh <= 23 && om <= 59;
}

/**
 * Decides whether a source can be offered as a link. Only http(s) URLs get an href; everything
 * else is kept as text.
 * @param {unknown} value the record's sourceUrl
 * @returns {{ source: { raw: string, href: string|null, status: string }, flags: string[], dedupeKey: string }}
 */
export function normalizeSource(value) {
  const raw = typeof value === 'string' ? value : '';
  const text = raw.trim();
  const plain = (status, flag) => ({ source: { raw, href: null, status }, flags: [flag], dedupeKey: text });
  const linked = (url, status, flags) => ({ source: { raw, href: url.href, status }, flags, dedupeKey: dedupeKey(url) });

  if (text === '') return plain('missing', 'source_missing');
  if (HTTP_URL.test(text)) {
    const url = URL.parse(text);
    return url?.hostname ? linked(url, 'ok', []) : plain('invalid', 'source_invalid');
  }
  // `forum.example:8080/x` also looks like a scheme followed by a colon.
  if (ANY_SCHEME.test(text) && !HOST_AND_PORT.test(text)) return plain('unsafe', 'source_unsafe');
  if (SCHEMELESS_URL.test(text)) {
    const url = URL.parse(`https://${text}`);
    if (url) return linked(url, 'scheme_assumed', ['source_scheme_assumed']);
  }
  return plain('invalid', 'source_invalid');
}

/** The same page whether or not it was shared with tracking parameters, a fragment or a trailing slash. */
function dedupeKey(url) {
  const key = new URL(url.href);
  // Rebuilt even without utm_* parameters, so that both sides of a comparison are encoded the same way.
  key.search = new URLSearchParams([...key.searchParams].filter(([name]) => !name.toLowerCase().startsWith('utm_'))).toString();
  key.hash = '';
  key.pathname = key.pathname.replace(/\/+$/, '') || '/';
  // The URL parser has already lower-cased the host (http and https are special schemes).
  return key.toString();
}
