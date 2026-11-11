import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore, loadStore } from '../../src/core/store.js';
import { parseSearchParams } from '../../src/core/params.js';

const realPath = fileURLToPath(new URL('../../findings.json', import.meta.url));
const fixturePath = fileURLToPath(new URL('../fixtures/small.json', import.meta.url));
const store = loadStore(realPath);
const fixtureStore = loadStore(fixturePath);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);

test('stats is the ingest report', () => {
  const { stats } = store;
  assert.deepEqual(
    [stats.records, stats.skipped, stats.findings, stats.canonical, stats.duplicates, stats.cases, stats.declaredCount, stats.countMismatch],
    [1032, 0, 1032, 1002, 30, 40, 1032, false],
  );
  assert.equal(stats.flags.reingested_duplicate, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats, 'plain, serialisable data');
});

test('getFinding: trimmed and case-insensitive, with raw', () => {
  const finding = store.getFinding(' f-10327 ');
  assert.ok(finding);
  assert.equal(finding.id, 'F-10327');
  assert.equal(finding.observedAt, '2026-09-10T11:11:30.000Z');
  assert.equal(finding.raw.observedAt, '2026-09-10T14:11:30+03:00');
  assert.equal(store.getFinding('F-10327'), finding, 'the same shared object');
  assert.equal(store.getFinding('f-10578-2').entity, 'sable-nimbus.test');
  assert.equal(store.getFinding('F-10578').type, 'wallet');
  assert.equal(store.getFinding('F-20004').duplicateOf, 'F-10308');
});

test('getFinding: unknown or not a string', () => {
  for (const id of ['nope', '', '   ', 'F-1032', 'F-10327x']) assert.equal(store.getFinding(id), null, id);
  for (const id of [42, null, undefined, ['F-10327'], { id: 'F-10327' }]) assert.equal(store.getFinding(id), null, String(id));
});

test('getFinding: a record without an id is reachable by its generated name', () => {
  const small = createStore([{ entity: 'a.test' }]);
  assert.equal(small.getFinding('row-0').entity, 'a.test');
  assert.equal(small.getFinding('ROW-0').entity, 'a.test');
});

test('search goes through the same findings as getFinding', () => {
  const result = store.search(parseSearchParams({ query: 'sokolaadimees' }).value);
  assert.equal(result.total, 13);
  for (const hit of result.results) {
    const { score, highlights, ...summary } = hit;
    const { raw, ...expected } = store.getFinding(hit.id);
    assert.deepEqual(summary, expected);
  }
});

test('listCases on the real file', () => {
  const { cases, unassigned } = store.listCases();
  assert.deepEqual(cases.map((c) => c.caseId), Array.from({ length: 40 }, (_, i) => `C-${101 + i}`));
  assert.deepEqual(unassigned, { findingCount: 1 });
  // 1002 canonical findings, minus F-10767 (no case), plus one because F-10906 counts in C-104 and C-122.
  assert.equal(sum(cases, 'findingCount'), 1002);
  assert.equal(sum(cases, 'duplicateCount'), 30);
  for (const c of cases) {
    assert.deepEqual(Object.keys(c), ['caseId', 'findingCount', 'duplicateCount', 'types', 'firstObservedAt', 'lastObservedAt']);
    assert.deepEqual(Object.keys(c.types), ['domain', 'ip', 'email', 'handle', 'alias', 'wallet', 'unknown']);
    assert.equal(Object.values(c.types).reduce((a, b) => a + b, 0), c.findingCount, c.caseId);
    assert.match(c.firstObservedAt, ISO);
    assert.match(c.lastObservedAt, ISO);
    assert.ok(c.firstObservedAt <= c.lastObservedAt, c.caseId);
  }
  const search = (caseId) => store.search(parseSearchParams({ query: '', caseId }).value).total;
  for (const c of cases) assert.equal(c.findingCount, search(c.caseId), `${c.caseId} agrees with search`);
  assert.equal(unassigned.findingCount, search('unassigned'));
});

test('listCases on the fixture', () => {
  const { cases, unassigned } = fixtureStore.listCases();
  assert.deepEqual(unassigned, { findingCount: 0 });
  assert.deepEqual(cases.find((c) => c.caseId === 'C-102'), {
    caseId: 'C-102',
    findingCount: 3,
    duplicateCount: 1,
    types: { domain: 1, ip: 0, email: 1, handle: 1, alias: 0, wallet: 0, unknown: 0 },
    firstObservedAt: '2026-09-12T09:30:00.000Z',
    lastObservedAt: '2026-09-17T14:00:00.000Z',
  });
  assert.deepEqual(cases.map((c) => [c.caseId, c.findingCount, c.duplicateCount]), [['C-101', 4, 0], ['C-102', 3, 1], ['C-103', 4, 0]]);
});

test('listCases: sorted by number, multi-case findings in each, findings without a time ignored for the range', () => {
  const small = createStore([
    { id: 'F-1', entity: 'a.test', caseId: ['C-10', 'C-9'], observedAt: '2026-09-10T10:00:00Z' },
    { id: 'F-2', entity: 'b.test', caseId: 'C-10', observedAt: 'never' },
    { id: 'F-3', entity: 'c.test', caseId: null, observedAt: '2026-09-10T10:00:00Z' },
  ]);
  const { cases, unassigned } = small.listCases();
  assert.deepEqual(cases.map((c) => [c.caseId, c.findingCount]), [['C-9', 1], ['C-10', 2]]);
  assert.equal(cases[1].firstObservedAt, '2026-09-10T10:00:00.000Z');
  assert.equal(cases[1].lastObservedAt, '2026-09-10T10:00:00.000Z');
  assert.deepEqual(unassigned, { findingCount: 1 });
  const noTimes = createStore([{ id: 'F-1', entity: 'a.test', caseId: 'C-1' }]).listCases().cases[0];
  assert.deepEqual([noTimes.firstObservedAt, noTimes.lastObservedAt], [null, null]);
});

test('loadStore names the file when it cannot load it', () => {
  const missing = '/nonexistent/findings.json';
  assert.throws(() => loadStore(missing), (error) => error.message.startsWith(`Cannot load ${missing}: `) && error.cause?.code === 'ENOENT');
  const notJson = fileURLToPath(import.meta.url);
  assert.throws(() => loadStore(notJson), (error) => error.message.includes(notJson) && error.cause instanceof SyntaxError);
  const wrongShape = fileURLToPath(new URL('../../package.json', import.meta.url));
  assert.throws(() => loadStore(wrongShape), (error) => error.message.includes(wrongShape) && error.message.includes('"findings" array'));
});

test('loadStore and createStore agree', () => {
  const created = createStore(JSON.parse(readFileSync(realPath, 'utf8')));
  assert.deepEqual(created.stats, store.stats);
  assert.deepEqual(created.listCases(), store.listCases());
});
