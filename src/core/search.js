import { fold, foldText } from './fold.js';
import { GLOSSARY } from './glossary.js';
import { FINDING_TYPES, UNASSIGNED } from './params.js';

const EXACT = 4;
const STEM = 2;
const GLOSSARY_WEIGHT = 1;

/**
 * Folds every searchable field once, so a query is a linear scan with indexOf.
 * @param {object[]} findings from ingest
 */
export function createIndex(findings) {
  return findings.map((finding) => {
    const { raw, ...summary } = finding;
    return {
      finding,
      summary,
      entity: fold(finding.entity),
      notes: fold(finding.notes),
      observedAtMs: finding.observedAt === null ? null : Date.parse(finding.observedAt),
    };
  });
}

/**
 * The strings tried for one folded query term, most specific first: the term itself, its stems,
 * then translations. Stems are crude suffix stripping: enough for Estonian case endings and
 * English plurals, never shorter than 4 letters.
 * @param {string} term already folded
 * @returns {{ s: string, w: number }[]}
 */
export function termVariants(term) {
  const variants = [{ s: term, w: EXACT }];
  if (/^\p{L}+$/u.test(term) && term.length >= 5) {
    for (let k = 1; k <= 3 && term.length - k >= 4; k++) variants.push({ s: term.slice(0, -k), w: STEM });
  }
  for (const group of GLOSSARY) {
    // A short prefix such as "dom" is too ambiguous to pull in a whole group; "dome" is not.
    if (!group.some((stem) => term.startsWith(stem) || (term.length >= 4 && stem.startsWith(term)))) continue;
    for (const stem of group) {
      if (!variants.some((v) => v.s === stem)) variants.push({ s: stem, w: GLOSSARY_WEIGHT });
    }
  }
  return variants;
}

/**
 * @param {ReturnType<typeof createIndex>} index
 * @param {import('./params.js').SearchParams} params validated by parseSearchParams
 */
export function search(index, params) {
  const terms = [...new Set(foldText(params.query).split(/\s+/).filter(Boolean))];
  const variantLists = terms.map(termVariants);

  const matches = [];
  for (const entry of index) {
    if (!passesFilters(entry, params)) continue;
    const match = matchEntry(entry, variantLists);
    if (match !== null) matches.push({ entry, ...match });
  }

  // Counted before the type filter, so the UI can show what each type choice would return.
  const types = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0]));
  for (const { entry } of matches) types[entry.finding.type] += 1;

  const selected = params.types.length === 0 ? matches : matches.filter((m) => params.types.includes(m.entry.finding.type));
  selected.sort(terms.length > 0 ? byScore : byTime);

  return {
    total: selected.length,
    limit: params.limit,
    offset: params.offset,
    facets: { types },
    results: selected.slice(params.offset, params.offset + params.limit).map(({ entry, score, highlights }) => ({
      ...entry.summary,
      score,
      highlights,
    })),
  };
}

function passesFilters(entry, { includeDuplicates, caseId, from, to }) {
  const { finding, observedAtMs } = entry;
  if (finding.duplicateOf !== null && !includeDuplicates) return false;
  if (caseId === UNASSIGNED && finding.caseIds.length > 0) return false;
  if (caseId !== null && caseId !== UNASSIGNED && !finding.caseIds.includes(caseId)) return false;
  if (from !== null || to !== null) {
    if (observedAtMs === null) return false;
    if (from !== null && observedAtMs < from) return false;
    if (to !== null && observedAtMs > to) return false;
  }
  return true;
}

/**
 * Every term must match the entity or the notes (AND); returns null when one does not. A term
 * scores variant weight × position factor in its better field, so an exact entity beats a prefix,
 * a whole word beats a fragment, and a literal match beats a stem or a translation.
 */
function matchEntry(entry, variantLists) {
  let score = 0;
  const ranges = { entity: [], notes: [] };
  for (const variants of variantLists) {
    let termScore = 0;
    for (const field of ['entity', 'notes']) {
      const { text, starts, ends } = entry[field];
      const variant = variants.find((v) => text.includes(v.s));
      if (variant === undefined) continue;
      const found = occurrences(text, variant.s);
      termScore = Math.max(termScore, variant.w * positionFactor(field, text, variant, found));
      for (const at of found) ranges[field].push([starts[at], ends[at + variant.s.length - 1]]);
    }
    if (termScore === 0) return null;
    score += termScore;
  }
  return { score, highlights: { entity: mergeRanges(ranges.entity), notes: mergeRanges(ranges.notes) } };
}

function positionFactor(field, text, variant, found) {
  if (field === 'entity' && variant.w === EXACT && text === variant.s) return 4;
  if (field === 'entity' && found[0] === 0) return 3;
  if (found.some((at) => at === 0 || !/[a-z0-9]/.test(text[at - 1]))) return 2;
  return 1;
}

function occurrences(text, s) {
  const found = [];
  for (let at = text.indexOf(s); at !== -1; at = text.indexOf(s, at + s.length)) found.push(at);
  return found;
}

/** Sorted, with overlapping or touching ranges joined, so the UI can cut the text in one pass. */
function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function byScore(a, b) {
  return b.score - a.score || byTime(a, b);
}

/** Newest first; findings without a time last; then by id so the order never depends on input order. */
function byTime(a, b) {
  const ta = a.entry.observedAtMs;
  const tb = b.entry.observedAtMs;
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  const ia = a.entry.finding.id;
  const ib = b.entry.finding.id;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
