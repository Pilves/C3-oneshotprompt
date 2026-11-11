import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ingest } from '../../src/core/ingest.js';
import { createIndex, search, termVariants } from '../../src/core/search.js';
import { parseSearchParams } from '../../src/core/params.js';
import { foldText } from '../../src/core/fold.js';
import { GLOSSARY } from '../../src/core/glossary.js';

const readFile = () => JSON.parse(readFileSync(new URL('../../findings.json', import.meta.url), 'utf8'));
const fileRecords = readFile().findings;
const { findings } = ingest(readFile());
const index = createIndex(findings);

/** Every highlight range is well formed and covers text that a variant of a query term matched. */
function assertHitInvariants(hit, query) {
  const variants = [...new Set(foldText(query).split(/\s+/).filter(Boolean))].flatMap((t) => termVariants(t).map((v) => v.s));
  assert.equal('raw' in hit, false, 'search results never carry raw');
  assert.equal(typeof hit.score, 'number');
  for (const field of ['entity', 'notes']) {
    const ranges = hit.highlights[field];
    assert.ok(Array.isArray(ranges));
    let previousEnd = -1;
    for (const range of ranges) {
      assert.equal(range.length, 2);
      const [start, end] = range;
      assert.ok(Number.isInteger(start) && Number.isInteger(end), `${hit.id} ${field} ${range}`);
      assert.ok(start >= 0 && start < end && end <= hit[field].length, `${hit.id} ${field} ${range} out of bounds`);
      assert.ok(start > previousEnd, `${hit.id} ${field} ranges must be sorted, apart and not touching`);
      previousEnd = end;
      const matched = foldText(hit[field].slice(start, end));
      assert.ok(variants.some((v) => matched.includes(v)), `${hit.id} ${field} "${matched}" matches no variant of "${query}"`);
    }
  }
}

/** Runs one page of a search through the shared validator, checking every hit. */
function run(input, searchIndex = index) {
  const parsed = parseSearchParams(input);
  assert.ok(parsed.ok, JSON.stringify(parsed.errors));
  const result = search(searchIndex, parsed.value);
  for (const hit of result.results) assertHitInvariants(hit, parsed.value.query);
  return result;
}

/** All results, in order, by paging. */
function runAll(input, limit = 100) {
  const first = run({ ...input, limit, offset: 0 });
  const results = [...first.results];
  while (results.length < first.total) results.push(...run({ ...input, limit, offset: results.length }).results);
  return { ...first, results };
}

const ids = (result) => result.results.map((hit) => hit.id);
const sliceOf = (hit, field, i = 0) => hit[field].slice(...hit.highlights[field][i]);

/** Findings built from a handful of records, for rules the real data does not exercise. */
function smallIndex(records) {
  return createIndex(ingest(records.map((r, i) => ({ id: `F-${i + 1}`, caseId: 'C-1', type: 'domain', sourceUrl: 'https://forum.example/1', observedAt: '2026-09-10T10:00:00Z', ...r }))).findings);
}

test('sokolaadimees: with or without diacritics, in any case', () => {
  const results = ['sokolaadimees', 'ŠOKOLAADIMEES', 'Šokolaadimees', '  sokolaadimees  '].map((query) => runAll({ query }));
  assert.equal(results[0].total, 13);
  for (const result of results.slice(1)) assert.deepEqual(ids(result), ids(results[0]));
  for (const hit of results[0].results) {
    assert.equal(hit.entity, 'Šokolaadimees');
    assert.deepEqual(hit.highlights.entity, [[0, 13]]);
  }
});

test('kampaania: inside an Estonian compound', () => {
  const result = runAll({ query: 'kampaania' });
  assert.equal(result.total, 63);
  for (const hit of result.results) {
    assert.equal(hit.notes, 'Kasutaja märgiti õngitsuskampaanias.');
    assert.deepEqual(hit.highlights.entity, []);
    assert.equal(sliceOf(hit, 'notes'), 'kampaania');
  }
});

test('sisselogimine: a stem finds another inflection', () => {
  const result = runAll({ query: 'sisselogimine' });
  assert.equal(result.total, 45);
  for (const hit of result.results) {
    assert.equal(hit.notes, 'Žurnaal näitas korduvaid sisselogimisi öösel.');
    assert.equal(sliceOf(hit, 'notes'), 'sisselogimi');
  }
});

test('domeenid: plural finds the singular', () => {
  const result = runAll({ query: 'domeenid' });
  assert.equal(result.total, 56);
  for (const hit of result.results) {
    assert.match(hit.notes, /^Domeen registreeriti/);
    assert.equal(sliceOf(hit, 'notes'), 'Domeen');
  }
});

test('rünnakule: a stem finds rünnakut, the glossary finds the English note', () => {
  const result = runAll({ query: 'rünnakule' });
  const estonian = result.results.filter((hit) => hit.notes.endsWith('enne rünnakut.'));
  const english = result.results.filter((hit) => hit.notes === 'Registered three days before the incident.');
  assert.equal(estonian.length, 56);
  assert.equal(english.length, 67);
  assert.equal(result.total, estonian.length + english.length);
  for (const hit of estonian) assert.equal(sliceOf(hit, 'notes'), 'rünnaku');
  for (const hit of english) assert.equal(sliceOf(hit, 'notes'), 'incident');
});

test('0xc008: a wallet prefix', () => {
  const result = runAll({ query: '0xc008' });
  assert.deepEqual(ids(result), ['F-10255']);
  const [hit] = result.results;
  assert.deepEqual(hit.highlights.entity, [[0, 6]]);
  assert.equal(hit.highlights.notes.length, 1);
  assert.equal(sliceOf(hit, 'notes'), '0xc008');
});

test('@raven-tundra: an email domain fragment; the upper-case copy only with duplicates', () => {
  const result = runAll({ query: '@raven-tundra' });
  assert.deepEqual(ids(result), ['F-10308', 'F-10266']);
  for (const hit of result.results) assert.match(hit.entity, /@raven-tundra\.test$/);

  const withCopies = runAll({ query: '@raven-tundra', includeDuplicates: true });
  assert.equal(withCopies.total, 3);
  const copy = withCopies.results.find((hit) => hit.id === 'F-20004');
  assert.ok(copy);
  assert.equal(copy.duplicateOf, 'F-10308');
  assert.equal(sliceOf(copy, 'entity'), '@RAVEN-TUNDRA');
});

test('script: hostile notes are returned byte for byte', () => {
  const result = runAll({ query: 'script' });
  const hit = result.results.find((h) => h.id === 'F-10062');
  assert.ok(hit);
  assert.equal(hit.notes, fileRecords.find((r) => r.id === 'F-10062').notes);
  assert.deepEqual(hit.highlights.notes.map(([s, e]) => hit.notes.slice(s, e)), ['script', 'script']);
});

test('fail serverist: every term must match', () => {
  const result = runAll({ query: 'fail serverist' });
  assert.equal(result.total, 62);
  for (const hit of result.results) {
    assert.equal(hit.notes, 'Šifreeritud fail leiti serverist.');
    assert.deepEqual(hit.highlights.notes.map(([s, e]) => hit.notes.slice(s, e)), ['fail', 'serverist']);
  }
  assert.equal(run({ query: 'fail zzzzqqq' }).total, 0);
});

test('zzzzqqq: nothing', () => {
  const result = run({ query: 'zzzzqqq' });
  assert.equal(result.total, 0);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.facets.types, { domain: 0, ip: 0, email: 0, handle: 0, alias: 0, wallet: 0, unknown: 0 });
});

test('repeated terms count once', () => {
  assert.deepEqual(run({ query: 'kampaania KAMPAANIA' }).results, run({ query: 'kampaania' }).results);
});

test('empty query lists everything newest first; duplicates only on request', () => {
  const all = runAll({ query: '' });
  assert.equal(all.total, 1002);
  assert.ok(all.results.every((hit) => hit.duplicateOf === null && hit.score === 0));
  assert.ok(all.results.every((hit) => hit.highlights.entity.length === 0 && hit.highlights.notes.length === 0));
  for (let i = 1; i < all.results.length; i++) {
    const [a, b] = [all.results[i - 1], all.results[i]];
    assert.ok(a.observedAt > b.observedAt || (a.observedAt === b.observedAt && a.id < b.id), `${a.id} before ${b.id}`);
  }
  assert.equal(runAll({ query: '', includeDuplicates: true }).total, 1032);
});

test('filter: type', () => {
  const result = runAll({ query: '', types: ['unknown'] });
  assert.deepEqual(ids(result), ['F-10582']);
  const ipOrDomain = runAll({ query: '', types: 'ip,domain' });
  const expected = findings.filter((f) => f.duplicateOf === null && (f.type === 'ip' || f.type === 'domain')).length;
  assert.equal(ipOrDomain.total, expected);
  assert.ok(ipOrDomain.results.every((hit) => hit.type === 'ip' || hit.type === 'domain'));
});

test('filter: case', () => {
  assert.deepEqual(ids(runAll({ query: '', caseId: 'unassigned' })), ['F-10767']);
  for (const caseId of ['C-104', 'C-122']) {
    const result = runAll({ query: '', caseId });
    assert.ok(ids(result).includes('F-10906'), caseId);
    assert.ok(result.results.every((hit) => hit.caseIds.includes(caseId)));
  }
  assert.equal(run({ query: '', caseId: 'C-999' }).total, 0);
});

test('filter: date range is inclusive and in UTC', () => {
  const result = runAll({ query: '', from: '2026-10-31', to: '2026-10-31' });
  assert.ok(result.total > 0);
  assert.ok(result.results.every((hit) => hit.observedAt.startsWith('2026-10-31T')));
  assert.equal(result.results[0].observedAt, '2026-10-31T22:18:34.000Z');
  const exact = runAll({ query: '', from: '2026-10-31T22:18:34Z', to: '2026-10-31T22:18:34Z' });
  assert.equal(exact.total, 1);
  assert.equal(run({ query: '', from: '2026-10-31T22:18:34.001Z' }).total, 0);
  assert.equal(run({ query: '', to: '2026-09-01T00:27:16.999Z' }).total, 0);
});

test('filter: a finding without a time is excluded by any date bound', () => {
  const small = smallIndex([{ entity: 'a.test' }, { entity: 'b.test', observedAt: 'not a date' }]);
  assert.deepEqual(ids(run({ query: '' }, small)), ['F-1', 'F-2']);
  assert.deepEqual(ids(run({ query: '', from: '2000-01-01' }, small)), ['F-1']);
  assert.deepEqual(ids(run({ query: '', to: '2100-01-01' }, small)), ['F-1']);
});

test('filters and text combine', () => {
  const result = runAll({ query: 'kampaania', types: ['ip'], caseId: 'C-104' });
  assert.equal(result.total, 2);
  assert.ok(result.results.every((hit) => hit.type === 'ip' && hit.caseIds.includes('C-104') && hit.notes.includes('kampaania')));
});

test('pagination: pages do not overlap and add up to the full ordering', () => {
  for (const query of ['', 'e', 'kampaania']) {
    const byHundred = runAll({ query }, 100);
    const bySeven = runAll({ query }, 7);
    assert.deepEqual(ids(bySeven), ids(byHundred), query);
    assert.equal(new Set(ids(byHundred)).size, byHundred.total, query);
  }
  const page = run({ query: '', limit: 5, offset: 1000 });
  assert.deepEqual([page.total, page.limit, page.offset, page.results.length], [1002, 5, 1000, 2]);
  assert.deepEqual(run({ query: '', offset: 5000 }).results, []);
});

test('ordering is deterministic and does not depend on input order', () => {
  const reversed = createIndex(findings.toReversed());
  for (const query of ['', 'e', 'a o', 'kampaania', '198.51']) {
    const first = ids(runAll({ query }));
    assert.deepEqual(ids(runAll({ query })), first, query);
    const parsed = parseSearchParams({ query, limit: 100 }).value;
    assert.deepEqual(search(reversed, parsed).results.map((h) => h.id), first.slice(0, 100), query);
  }
});

test('a 200-character query of single letters', () => {
  const query = 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(8).slice(0, 200);
  const result = run({ query });
  assert.equal(typeof result.total, 'number');
});

test('stem variants: only purely alphabetic terms of five or more letters', () => {
  assert.deepEqual(termVariants('sisselogimine').filter((v) => v.w > 1).map((v) => [v.s, v.w]), [
    ['sisselogimine', 4], ['sisselogimin', 2], ['sisselogimi', 2], ['sisselogim', 2],
  ]);
  assert.deepEqual(termVariants('kaske').map((v) => v.s), ['kaske', 'kask']);
  assert.deepEqual(termVariants('kask').map((v) => v.s), ['kask']);
  assert.deepEqual(termVariants('198.51.100.2').map((v) => v.s), ['198.51.100.2']);
  assert.deepEqual(termVariants('ip-aadress').map((v) => v.s), ['ip-aadress']);
});

const ESTONIAN_PHISHING = 'Kasutaja märgiti õngitsuskampaanias.';
const isEnglishPhishing = (hit) => hit.notes === `Seen in phishing kit config for ${hit.entity}.`;

test('ongitsus: finds the Estonian note and, through the glossary, the English one', () => {
  const result = runAll({ query: 'ongitsus' });
  const estonian = result.results.filter((hit) => hit.notes === ESTONIAN_PHISHING);
  const english = result.results.filter(isEnglishPhishing);
  assert.deepEqual([estonian.length, english.length, result.total], [63, 61, 124]);
  for (const hit of estonian) assert.equal(sliceOf(hit, 'notes'), 'õngitsus');
  for (const hit of english) assert.equal(sliceOf(hit, 'notes'), 'phish');
});

test('phishing: the same findings as ongitsus', () => {
  const phishing = runAll({ query: 'phishing' });
  assert.deepEqual(ids(phishing).toSorted(), ids(runAll({ query: 'ongitsus' })).toSorted());
  for (const hit of phishing.results.filter((h) => h.notes === ESTONIAN_PHISHING)) assert.equal(sliceOf(hit, 'notes'), 'õngits');
  for (const hit of phishing.results.filter(isEnglishPhishing)) assert.equal(sliceOf(hit, 'notes'), 'phishing');
});

test('õngitsemine: an inflection that only the glossary stem covers still finds both languages', () => {
  assert.deepEqual(ids(runAll({ query: 'õngitsemine' })).toSorted(), ids(runAll({ query: 'ongitsus' })).toSorted());
});

test('glossary entries are folded, so they can match folded text', () => {
  for (const group of GLOSSARY) {
    assert.ok(group.length > 0);
    for (const stem of group) {
      assert.equal(stem, foldText(stem), stem);
      assert.match(stem, /^[a-z]+$/, stem);
    }
  }
});

test('glossary variants come after stems, without repeats', () => {
  assert.deepEqual(termVariants('phishing').map((v) => [v.s, v.w]), [
    ['phishing', 4], ['phishin', 2], ['phishi', 2], ['phish', 2], ['ongits', 1],
  ]);
  assert.deepEqual(termVariants('ongitsus').map((v) => [v.s, v.w]), [
    ['ongitsus', 4], ['ongitsu', 2], ['ongits', 2], ['ongit', 2], ['phish', 1],
  ]);
  assert.deepEqual(termVariants('login').map((v) => v.s), ['login', 'logi', 'log', 'journal', 'zurnaal', 'sisselogi']);
  assert.deepEqual(termVariants('dome').map((v) => v.s), ['dome', 'domain', 'domeen'], 'a 4-letter prefix of a stem pulls in its group');
  assert.deepEqual(termVariants('dom').map((v) => v.s), ['dom'], 'a shorter one does not');
  assert.deepEqual(termVariants('198.51').map((v) => v.s), ['198.51']);
});

// ---- Ranking and facets ----

test('ongitsus: every Estonian (literal) match ranks above every English (glossary) one', () => {
  const result = runAll({ query: 'ongitsus' });
  const lastEstonian = result.results.findLastIndex((hit) => hit.notes === ESTONIAN_PHISHING);
  const firstEnglish = result.results.findIndex(isEnglishPhishing);
  assert.equal(lastEstonian, 62);
  assert.equal(firstEnglish, 63);
});

test('phishing: English (literal) matches rank first', () => {
  const result = runAll({ query: 'phishing' });
  assert.equal(result.results.findLastIndex(isEnglishPhishing), 60);
  assert.equal(result.results.findIndex((hit) => hit.notes === ESTONIAN_PHISHING), 61);
});

test('198.51.100.2: the exact entity first, then entities that start with it', () => {
  const result = runAll({ query: '198.51.100.2' });
  assert.equal(result.total, 11);
  const [first, ...rest] = result.results;
  assert.equal(first.entity, '198.51.100.2');
  assert.equal(first.score, 16);
  for (const hit of rest) {
    assert.ok(hit.entity.startsWith('198.51.100.2'), hit.entity);
    assert.equal(hit.score, 12);
  }
});

test('c2: a whole word in the notes beats a fragment of hex digits', () => {
  const result = runAll({ query: 'c2' });
  assert.match(result.results[0].notes, /C2 range/);
  const firstFragmentOnly = result.results.findIndex((hit) => !hit.notes.includes('C2 range'));
  assert.ok(result.results.slice(0, firstFragmentOnly).every((hit) => hit.notes.includes('C2 range')));
  assert.ok(result.results.slice(firstFragmentOnly).every((hit) => !hit.notes.includes('C2 range')));
});

test('score = variant weight x position factor, summed over terms', () => {
  const small = smallIndex([
    { entity: 'kask.test', notes: 'Õngitsus.' }, // F-1
    { entity: 'kask.test.example' }, // F-2
    { entity: 'x.kask.test' }, // F-3
    { entity: 'xkask.test' }, // F-4
    { entity: 'other.test', notes: 'See kask.test oli.' }, // F-5
    { entity: 'other.test', notes: 'xkask.test' }, // F-6
    { entity: 'other.test', notes: 'kask.test oli.' }, // F-7
    { entity: 'xongits', notes: 'Phishing.' }, // F-8
  ]);
  const scores = (query) => Object.fromEntries(run({ query, limit: 100 }, small).results.map((hit) => [hit.id, hit.score]));
  // Exact (4) x: equals the entity 4, starts the entity 3, word boundary 2, inside a word 1.
  assert.deepEqual(scores('kask.test'), { 'F-1': 16, 'F-2': 12, 'F-3': 8, 'F-5': 8, 'F-7': 8, 'F-4': 4, 'F-6': 4 });
  // Stem (2): "kask" at the start of the entity.
  assert.equal(scores('kaskede')['F-1'], 6);
  // Glossary (1): "ongits" starts F-1's notes (1 x 2). F-8's literal "phishing" (4 x 2) beats its glossary hit inside the entity (1 x 1).
  assert.deepEqual(scores('phishing'), { 'F-8': 8, 'F-1': 2 });
  // F-8 for "ongitsus": the stem "ongits" inside the entity (2 x 1) and the glossary "phish" starting the notes (1 x 2) tie.
  assert.equal(scores('ongitsus')['F-8'], 2);
  // Two terms add up.
  assert.equal(scores('kask.test õngitsus')['F-1'], 16 + 8);
});

test('each field uses the first variant that occurs in it', () => {
  const small = smallIndex([{ entity: 'domeeni.test', notes: 'Need domeenid on uued.' }]);
  const [hit] = run({ query: 'domeenid' }, small).results;
  // Entity: "domeenid" does not occur, so the stem "domeeni" is used: 2 x 3. Notes: exact at a word boundary: 4 x 2.
  assert.equal(hit.score, 8);
  assert.deepEqual(hit.highlights, { entity: [[0, 7]], notes: [[5, 13]] });
});

test('equal scores: newest first, then id', () => {
  const small = smallIndex([
    { entity: 'a.test', observedAt: '2026-09-10T10:00:00Z' },
    { entity: 'a.test', observedAt: '2026-09-11T10:00:00Z', notes: 'different' },
    { entity: 'a.test', observedAt: '2026-09-10T10:00:00Z', notes: 'different again' },
    { entity: 'a.test', observedAt: 'never', notes: 'no time' },
  ]);
  assert.deepEqual(ids(run({ query: 'a.test' }, small)), ['F-2', 'F-1', 'F-3', 'F-4']);
  assert.deepEqual(ids(run({ query: '' }, small)), ['F-2', 'F-1', 'F-3', 'F-4']);
});

test('highlights: all occurrences, merged when they touch or overlap', () => {
  const small = smallIndex([{ entity: 'abab.test', notes: 'Ö-öö ab ab' }]);
  const [hit] = run({ query: 'ab abab öö' }, small).results;
  assert.deepEqual(hit.highlights.entity, [[0, 4]]);
  assert.deepEqual(hit.highlights.notes, [[2, 4], [5, 7], [8, 10]]);
});

test('facets: per-type counts before the type filter, after every other filter', () => {
  const all = run({ query: 'ongitsus' });
  const sum = (types) => Object.values(types).reduce((a, b) => a + b, 0);
  assert.deepEqual(Object.keys(all.facets.types), ['domain', 'ip', 'email', 'handle', 'alias', 'wallet', 'unknown']);
  assert.equal(sum(all.facets.types), all.total);

  const ipOnly = run({ query: 'ongitsus', types: ['ip'] });
  assert.deepEqual(ipOnly.facets, all.facets, 'the type filter does not change the facets');
  assert.equal(ipOnly.total, all.facets.types.ip);

  const inCase = run({ query: 'ongitsus', caseId: 'C-104', types: ['wallet'] });
  const inCaseAll = run({ query: 'ongitsus', caseId: 'C-104' });
  assert.deepEqual(inCase.facets, inCaseAll.facets);
  assert.equal(sum(inCase.facets.types), inCaseAll.total);
  assert.ok(sum(inCase.facets.types) < sum(all.facets.types), 'the case filter does change them');

  const withCopies = run({ query: '', includeDuplicates: true });
  assert.equal(sum(withCopies.facets.types), 1032);
  assert.deepEqual(withCopies.facets.types, { domain: 179, ip: 172, email: 175, handle: 156, alias: 165, wallet: 184, unknown: 1 });
});
