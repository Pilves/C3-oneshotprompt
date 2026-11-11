export const FINDING_TYPES = ['domain', 'ip', 'email', 'handle', 'alias', 'wallet', 'unknown']; // this order everywhere
export const MAX_QUERY_LENGTH = 200;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 100000;
export const UNASSIGNED = 'unassigned';

const KNOWN_KEYS = new Set(['query', 'types', 'caseId', 'from', 'to', 'limit', 'offset', 'includeDuplicates']);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * @typedef {Object} SearchParams
 * @property {string} query
 * @property {string[]} types
 * @property {string|null} caseId
 * @property {number|null} from   epoch ms, inclusive
 * @property {number|null} to     epoch ms, inclusive
 * @property {number} limit
 * @property {number} offset
 * @property {boolean} includeDuplicates
 */

/**
 * Shared by the HTTP API (every value a string) and MCP (JSON-typed values), so both accept the same things.
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: SearchParams } | { ok: false, errors: { param: string, message: string }[] }}
 */
export function parseSearchParams(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('parseSearchParams expects a plain object');
  }
  const errors = [];
  const fail = (param, message) => errors.push({ param, message });

  const value = {
    query: parseQuery(input.query, fail),
    types: parseTypes(input.types, fail),
    caseId: parseCaseId(input.caseId, fail),
    from: parseBound(input.from, 'from', fail),
    to: parseBound(input.to, 'to', fail),
    limit: parseInteger(input.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT, fail),
    offset: parseInteger(input.offset, 'offset', 0, 0, MAX_OFFSET, fail),
    includeDuplicates: parseBoolean(input.includeDuplicates, fail),
  };
  // Only compared when both parsed, so an invalid bound is not reported twice.
  if (value.from !== null && value.to !== null && value.from > value.to) {
    fail('to', 'must not be earlier than from');
  }
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) fail(key, 'unknown parameter');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function parseQuery(raw, fail) {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') {
    fail('query', 'must be a string');
    return '';
  }
  const query = raw.trim();
  if (query.length > MAX_QUERY_LENGTH) fail('query', `must be at most ${MAX_QUERY_LENGTH} characters`);
  return query;
}

function parseTypes(raw, fail) {
  if (raw === undefined || raw === '') return [];
  let items;
  if (typeof raw === 'string') {
    // Empty items come from HTTP joining repeated parameters, e.g. `type=&type=ip` → ",ip".
    items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw) && raw.every((s) => typeof s === 'string')) {
    items = raw.map((s) => s.trim());
  } else {
    fail('types', 'must be an array of strings or a comma-separated string');
    return [];
  }
  const wanted = new Set(items.map((s) => s.toLowerCase()));
  const invalid = [...wanted].filter((t) => !FINDING_TYPES.includes(t));
  if (invalid.length > 0) {
    fail('types', `unknown type ${invalid.map((t) => JSON.stringify(t)).join(', ')}; allowed: ${FINDING_TYPES.join(', ')}`);
  }
  return FINDING_TYPES.filter((t) => wanted.has(t));
}

function parseCaseId(raw, fail) {
  if (raw === undefined || raw === '') return null;
  const caseId = typeof raw === 'string' ? raw.trim().toUpperCase() : null;
  if (caseId === UNASSIGNED.toUpperCase()) return UNASSIGNED;
  if (caseId !== null && /^C-\d+$/.test(caseId)) return caseId;
  fail('caseId', `must be a case id such as C-104, or "${UNASSIGNED}"`);
  return null;
}

function parseBound(raw, param, fail) {
  if (raw === undefined || raw === '') return null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const dateOnly = DATE_ONLY.exec(text);
  const dateTime = dateOnly ? null : DATE_TIME.exec(text);
  if (!dateOnly && !dateTime) {
    fail(param, 'must be a date (YYYY-MM-DD) or a date-time ending in Z or ±hh:mm');
    return null;
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0', oh = '0', om = '0'] = dateOnly ?? dateTime;
  // Date.parse rolls 2026-02-30 over to March and accepts 24:00, so check the fields first.
  const daysInMonth = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  const fieldsValid = Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= daysInMonth
    && Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59 && Number(oh) <= 23 && Number(om) <= 59;
  if (!fieldsValid) {
    fail(param, 'is not a valid date');
    return null;
  }
  if (dateOnly) {
    // A bare date means the whole UTC day, so `to` must reach its last millisecond.
    return Date.parse(`${text}T${param === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`);
  }
  return Date.parse(text);
}

function parseInteger(raw, param, fallback, min, max, fail) {
  if (raw === undefined || raw === '') return fallback;
  let n = NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(param, `must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

function parseBoolean(raw, fail) {
  if (raw === undefined || raw === '') return false;
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  fail('includeDuplicates', 'must be true or false');
  return false;
}
