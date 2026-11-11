import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ingest } from '../../src/core/ingest.js';
import { FLAGS } from '../../src/core/normalize.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = () => readJson('../fixtures/small.json');
const byId = (findings) => new Map(findings.map((f) => [f.id, f]));

/** A minimal valid record; tests override what they care about. */
const record = (id, extra = {}) => ({
  id,
  caseId: 'C-1',
  entity: `entity-${id}.test`,
  type: 'domain',
  sourceUrl: 'https://forum.example/1',
  observedAt: '2026-09-10T10:00:00Z',
  notes: 'Seen.',
  ...extra,
});

test('fixture: non-records are skipped and the rest kept in file order', () => {
  const { findings, report } = ingest(fixture());
  assert.equal(report.records, 13);
  assert.equal(report.skipped, 1);
  assert.equal(report.findings, 12);
  assert.deepEqual(findings.map((f) => f.id), [
    'F-1001', 'F-1002', 'F-1003', 'F-1004', 'F-1005', 'F-1006', 'F-1007', 'F-1007-2', 'F-2001', 'F-1008', 'F-1009', 'F-1010',
  ]);
  assert.equal(report.declaredCount, null);
  assert.equal(report.countMismatch, false);
});

test('fixture: a shared raw id becomes two addressable findings that point at each other', () => {
  const findings = byId(ingest(fixture()).findings);
  const first = findings.get('F-1007');
  const second = findings.get('F-1007-2');
  assert.equal(first.entity, '192.0.2.10');
  assert.equal(second.entity, 'sable-nimbus.test');
  assert.equal(second.rawId, 'F-1007');
  assert.deepEqual(first.sameRawId, ['F-1007-2']);
  assert.deepEqual(second.sameRawId, ['F-1007']);
  assert.deepEqual(first.flags, ['duplicate_id']);
  assert.deepEqual(second.flags, ['duplicate_id']);
  for (const f of findings.values()) {
    if (f.rawId !== 'F-1007') assert.deepEqual(f.sameRawId, [], f.id);
  }
});

test('fixture: per-record flags survive ingest', () => {
  const findings = byId(ingest(fixture()).findings);
  assert.deepEqual(findings.get('F-1008').flags, ['source_unsafe']);
  assert.deepEqual(findings.get('F-1009').flags, ['notes_markup']);
  assert.deepEqual(findings.get('F-1010').flags, ['notes_instruction_like']);
  assert.equal(findings.get('F-1009').notes, "<script>alert('fixture')</script>");
});

test('three records with one raw id become X, X-2, X-3', () => {
  const { findings } = ingest([record('X', { entity: 'a.test' }), record('X', { entity: 'b.test' }), record('X', { entity: 'c.test' })]);
  assert.deepEqual(findings.map((f) => f.id), ['X', 'X-2', 'X-3']);
  assert.deepEqual(findings.map((f) => f.sameRawId), [['X-2', 'X-3'], ['X', 'X-3'], ['X', 'X-2']]);
  assert.ok(findings.every((f) => f.flags.includes('duplicate_id') && f.rawId === 'X'));
});

test('a generated id never takes a raw id that exists elsewhere in the file', () => {
  const { findings } = ingest([record('X', { entity: 'a.test' }), record('X', { entity: 'b.test' }), record('X-2', { entity: 'c.test' })]);
  assert.deepEqual(findings.map((f) => f.id), ['X', 'X-3', 'X-2']);
  assert.deepEqual(findings[2].flags, [], 'X-2 shares its id with nobody');
});

test('ids that differ only in letter case collide, because lookups ignore case', () => {
  const { findings } = ingest([record('f-1', { entity: 'a.test' }), record('F-1', { entity: 'b.test' })]);
  assert.deepEqual(findings.map((f) => f.id), ['f-1', 'F-1-2']);
  assert.deepEqual(findings[1].sameRawId, ['f-1']);
});

test('records without an id are named by position and stay unique', () => {
  const { findings, report } = ingest([record(''), null, record(undefined), record('row-0')]);
  assert.deepEqual(findings.map((f) => f.id), ['row-0', 'row-2', 'row-0-2']);
  assert.equal(report.flags.id_missing, 2);
  assert.equal(report.flags.duplicate_id, 2);
});

test('duplicate_id is placed in FLAGS order', () => {
  const { findings } = ingest([record('X', { type: 'ip' }), record('X', { notes: null })]);
  assert.deepEqual(findings[0].flags, ['duplicate_id', 'type_mismatch']);
  assert.deepEqual(findings[1].flags, ['duplicate_id', 'notes_missing']);
});

test('a bare array is accepted', () => {
  const { findings, report } = ingest(fixture().findings);
  assert.equal(findings.length, 12);
  assert.equal(report.declaredCount, null);
});

test('a file without a findings array is rejected', () => {
  for (const dataset of [null, undefined, 'x', 42, {}, { findings: {} }, { findings: 'x' }, { data: [] }]) {
    assert.throws(() => ingest(dataset), { message: 'findings.json: expected an object with a "findings" array' }, JSON.stringify(dataset));
  }
});

test('the declared count is compared with the number of records', () => {
  assert.deepEqual(
    (({ declaredCount, countMismatch }) => ({ declaredCount, countMismatch }))(ingest({ _meta: { count: 3 }, findings: [record('A'), null] }).report),
    { declaredCount: 3, countMismatch: true },
  );
  assert.equal(ingest({ _meta: { count: 2 }, findings: [record('A'), null] }).report.countMismatch, false, 'skipped elements are still records');
  assert.equal(ingest({ _meta: { count: '2' }, findings: [] }).report.declaredCount, null);
});

test('report: flag counts include every flag', () => {
  const { report } = ingest(fixture());
  assert.deepEqual(Object.keys(report.flags), FLAGS);
  assert.equal(report.flags.duplicate_id, 2);
  assert.equal(report.flags.source_unsafe, 1);
  assert.equal(report.flags.notes_markup, 1);
  assert.equal(report.flags.notes_instruction_like, 1);
  assert.equal(report.flags.time_invalid, 0);
  assert.equal(report.cases, 3);
});

test('fixture: a re-ingested copy is linked to the original', () => {
  const findings = byId(ingest(fixture()).findings);
  const copy = findings.get('F-2001');
  const original = findings.get('F-1003');
  assert.equal(copy.duplicateOf, 'F-1003');
  assert.deepEqual(copy.flags, ['reingested_duplicate']);
  assert.deepEqual(copy.duplicates, []);
  assert.equal(original.duplicateOf, null);
  assert.deepEqual(original.duplicates, ['F-2001']);
  assert.deepEqual(original.flags, []);
  for (const f of findings.values()) {
    if (f !== copy) assert.equal(f.duplicateOf, null, f.id);
  }
  const { report } = ingest(fixture());
  assert.deepEqual([report.canonical, report.duplicates], [11, 1]);
});

test('the lowest id is canonical whatever the file order', () => {
  const records = fixture().findings;
  const orders = [records, records.toReversed(), [...records.slice(7), ...records.slice(0, 7)]];
  for (const order of orders) {
    const findings = byId(ingest(order).findings);
    assert.equal(findings.get('F-2001').duplicateOf, 'F-1003');
    assert.deepEqual(findings.get('F-1003').duplicates, ['F-2001']);
  }
});

test('canonical order: numeric part first, then id; ids without digits last', () => {
  const same = { entity: 'same.test' };
  const { findings } = ingest([record('F-20', same), record('F-3', same), record('alpha', same), record('F-3', same), record('F-100', same)]);
  const ids = findings.map((f) => f.id);
  assert.deepEqual(ids, ['F-20', 'F-3', 'alpha', 'F-3-2', 'F-100']);
  const canonical = findings[1];
  assert.deepEqual(canonical.duplicates, ['F-3-2', 'F-20', 'F-100', 'alpha']);
  for (const f of findings) if (f !== canonical) assert.equal(f.duplicateOf, 'F-3', f.id);
});

test('same id and same content: both kept, cross-linked by id and linked as duplicates', () => {
  const { findings } = ingest([record('X'), record('X')]);
  assert.deepEqual(findings.map((f) => f.id), ['X', 'X-2']);
  assert.deepEqual(findings[0].flags, ['duplicate_id']);
  assert.deepEqual(findings[1].flags, ['duplicate_id', 'reingested_duplicate']);
  assert.equal(findings[1].duplicateOf, 'X');
});

test('what makes two records the same observation', () => {
  const same = { entity: 'same.test' };
  const pair = (a, b) => ingest([record('F-1', { ...same, ...a }), record('F-2', { ...same, ...b })]).findings[1].duplicateOf;
  // Cosmetic differences are ignored.
  assert.equal(pair({ entity: 'Mail@Example.test ' }, { entity: 'mail@example.test' }), 'F-1');
  assert.equal(pair({ caseId: ['C-2', 'C-1'] }, { caseId: [' c-1', 'C-2'] }), 'F-1');
  assert.equal(pair({ observedAt: '2026-09-10T13:00:00+03:00' }, { observedAt: 1789034400000 }), 'F-1');
  assert.equal(pair({ sourceUrl: 'https://forum.example/1/' }, { sourceUrl: 'https://forum.example/1?utm_source=x' }), 'F-1');
  assert.equal(pair({ notes: 'Seen.' }, { notes: ' Seen. ' }), 'F-1');
  assert.equal(pair({ notes: null }, { notes: '  ' }), 'F-1');
  assert.equal(pair({ type: 'domain' }, { type: 'ip' }), 'F-1', 'the type label is not part of the observation');
  // Real differences are not.
  assert.equal(pair({ entity: 'a.test' }, { entity: 'b.test' }), null);
  assert.equal(pair({ entity: 'öökull' }, { entity: 'ookull' }), null, 'diacritics are distinct letters');
  assert.equal(pair({ caseId: 'C-1' }, { caseId: 'C-2' }), null);
  assert.equal(pair({ observedAt: '2026-09-10T10:00:00Z' }, { observedAt: '2026-09-10T10:00:01Z' }), null);
  assert.equal(pair({ sourceUrl: 'https://forum.example/1' }, { sourceUrl: 'https://forum.example/2' }), null);
  assert.equal(pair({ notes: 'Seen.' }, { notes: 'seen.' }), null);
  // Too little to compare.
  assert.equal(pair({ entity: '' }, { entity: '' }), null);
  assert.equal(pair({ observedAt: 'bad' }, { observedAt: 'bad' }), null);
});

// ---- The real dataset (docs/DESIGN.md section 4) ----

const realFile = () => readJson('../../findings.json');
const real = ingest(realFile());
const realById = byId(real.findings);
const get = (id) => {
  const f = realById.get(id);
  assert.ok(f, `no finding ${id}`);
  return f;
};
const idsWithFlag = (flag) => real.findings.filter((f) => f.flags.includes(flag)).map((f) => f.id).sort();

test('real: counts', () => {
  const { report } = real;
  assert.equal(report.records, 1032);
  assert.equal(report.skipped, 0);
  assert.equal(report.findings, 1032);
  assert.equal(report.canonical, 1002);
  assert.equal(report.duplicates, 30);
  assert.equal(report.cases, 40);
  assert.equal(report.declaredCount, 1032);
  assert.equal(report.countMismatch, false);
  for (const flag of FLAGS) assert.equal(report.flags[flag], idsWithFlag(flag).length, flag);
});

test('real: ids are unique and findings are in file order', () => {
  assert.equal(new Set(real.findings.map((f) => f.id.toUpperCase())).size, 1032);
  const file = realFile().findings;
  assert.deepEqual(real.findings.map((f) => f.rawId), file.map((r) => r.id));
});

test('real: raw is the record exactly as in the file', () => {
  const file = realFile().findings;
  real.findings.forEach((f, i) => assert.deepEqual(f.raw, file[i], f.id));
});

test('real: the 30 re-ingested copies', () => {
  const copies = real.findings.filter((f) => f.duplicateOf !== null);
  assert.deepEqual(copies.map((f) => f.id).sort(), Array.from({ length: 30 }, (_, i) => `F-${20000 + i}`));
  for (const copy of copies) {
    assert.match(copy.duplicateOf, /^F-1\d{4}$/, copy.id);
    const canonical = get(copy.duplicateOf);
    assert.equal(canonical.duplicateOf, null, 'a canonical finding is never itself a copy');
    assert.ok(canonical.duplicates.includes(copy.id));
    assert.deepEqual(copy.flags.filter((flag) => flag === 'reingested_duplicate'), ['reingested_duplicate']);
    assert.deepEqual(copy.duplicates, []);
  }
  const listed = real.findings.flatMap((f) => f.duplicates).sort();
  assert.deepEqual(listed, copies.map((f) => f.id).sort());
  assert.deepEqual(idsWithFlag('reingested_duplicate'), copies.map((f) => f.id).sort());
  const links = { 'F-20028': 'F-10845', 'F-20000': 'F-10232', 'F-20004': 'F-10308', 'F-20001': 'F-10233', 'F-20014': 'F-10888' };
  for (const [copy, original] of Object.entries(links)) assert.equal(get(copy).duplicateOf, original, copy);
});

test('real: id collisions', () => {
  const expected = [
    ['F-10578', 'wallet', /^0x502e/, ['C-103'], 'F-10578-2'],
    ['F-10578-2', 'domain', /^sable-nimbus\.test$/, ['C-116'], 'F-10578'],
    ['F-10401', 'ip', /^198\.51\.100\.46$/, ['C-140'], 'F-10401-2'],
    ['F-10401-2', 'handle', /^pixel_ember17$/, ['C-107'], 'F-10401'],
  ];
  for (const [id, type, entity, caseIds, other] of expected) {
    const f = get(id);
    assert.equal(f.type, type, id);
    assert.match(f.entity, entity, id);
    assert.deepEqual(f.caseIds, caseIds, id);
    assert.deepEqual(f.sameRawId, [other], id);
    assert.ok(f.flags.includes('duplicate_id'), id);
  }
  assert.deepEqual(idsWithFlag('duplicate_id'), ['F-10401', 'F-10401-2', 'F-10578', 'F-10578-2']);
  assert.ok(real.findings.every((f) => f.sameRawId.length === 0 || f.rawId === 'F-10578' || f.rawId === 'F-10401'));
});

test('real: cases', () => {
  const caseIds = new Set(real.findings.flatMap((f) => f.caseIds));
  assert.deepEqual([...caseIds].sort(), Array.from({ length: 40 }, (_, i) => `C-${101 + i}`));
  assert.deepEqual(real.findings.filter((f) => f.duplicateOf === null && f.caseIds.length === 0).map((f) => f.id), ['F-10767']);
  assert.deepEqual(get('F-10767').flags, ['case_missing']);
  assert.deepEqual(get('F-10906').caseIds, ['C-104', 'C-122']);
  assert.deepEqual(idsWithFlag('multi_case'), ['F-10906']);
  assert.deepEqual(get('F-10335').caseIds, ['C-117']);
  assert.deepEqual(get('F-10335').flags, []);
});

test('real: types', () => {
  const mismatches = { 'F-10788': 'domain', 'F-10819': 'ip', 'F-10142': 'email', 'F-10380': 'email', 'F-10582': 'unknown' };
  assert.deepEqual(idsWithFlag('type_mismatch'), Object.keys(mismatches).sort());
  for (const [id, type] of Object.entries(mismatches)) assert.equal(get(id).type, type, id);
  assert.equal(get('F-10917').type, 'email');
  assert.equal(get('F-10917').typeRaw, ' email ');
  assert.deepEqual(get('F-10917').flags, []);
  assert.equal(get('F-10276').type, 'alias');
  assert.deepEqual(get('F-10276').flags, []);
  const counts = {};
  for (const f of real.findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  assert.deepEqual(counts, { ip: 172, domain: 179, email: 175, handle: 156, alias: 165, wallet: 184, unknown: 1 });
});

test('real: sources', () => {
  assert.deepEqual(get('F-10748').source.status, 'unsafe');
  assert.equal(get('F-10748').source.href, null);
  assert.deepEqual(get('F-10968').source, { raw: "javascript:alert('check your links')", href: null, status: 'unsafe' });
  assert.deepEqual(get('F-10930').source, { raw: 'forum.example/thread/88', href: 'https://forum.example/thread/88', status: 'scheme_assumed' });
  assert.deepEqual(get('F-10381').source, { raw: '', href: null, status: 'missing' });
  const odd = new Set(['F-10748', 'F-10968', 'F-10930', 'F-10381']);
  const ok = real.findings.filter((f) => !odd.has(f.id));
  assert.equal(ok.length, 1028);
  for (const f of ok) {
    assert.equal(f.source.status, 'ok', f.id);
    assert.equal(f.source.href, f.raw.sourceUrl, 'the link is the URL as collected');
  }
  assert.deepEqual(idsWithFlag('source_unsafe'), ['F-10748', 'F-10968']);
  assert.deepEqual(idsWithFlag('source_scheme_assumed'), ['F-10930']);
  assert.deepEqual(idsWithFlag('source_missing'), ['F-10381']);
});

test('real: notes', () => {
  assert.deepEqual(idsWithFlag('notes_missing'), ['F-10326', 'F-10431', 'F-10445', 'F-10773', 'F-10780', 'F-10847', 'F-10955']);
  assert.deepEqual(idsWithFlag('notes_markup'), ['F-10056', 'F-10062', 'F-10365', 'F-10457', 'F-10463', 'F-10934', 'F-10995']);
  assert.deepEqual(idsWithFlag('notes_instruction_like'), ['F-10034', 'F-10209', 'F-10463', 'F-10661']);
  for (const id of ['F-10955', 'F-10780', 'F-10773', 'F-10431', 'F-10445', 'F-10326', 'F-10847']) assert.equal(get(id).notes, '', id);
  assert.equal(get('F-10062').notes, "<script>alert('escape your output')</script>");
});

test('real: flags that never occur', () => {
  for (const flag of ['time_invalid', 'case_invalid', 'entity_missing', 'id_missing', 'source_invalid']) {
    assert.deepEqual(idsWithFlag(flag), [], flag);
  }
});

test('real: observation times', () => {
  const times = real.findings.map((f) => f.observedAt).sort();
  assert.equal(times[0], '2026-09-01T00:27:17.000Z');
  assert.equal(times.at(-1), '2026-10-31T22:18:34.000Z');
  assert.equal(get('F-10327').observedAt, '2026-09-10T11:11:30.000Z');
});

test('real: trimmed entities', () => {
  const trimmed = real.findings.filter((f) => f.entity !== f.raw.entity).map((f) => f.id).sort();
  assert.deepEqual(trimmed, ['F-20000', 'F-20005', 'F-20007', 'F-20017']);
  assert.equal(get('F-20017').entity, 'Öökull');
});
