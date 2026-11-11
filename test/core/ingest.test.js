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
  sourceUrl: `https://forum.example/${id}`,
  observedAt: '2026-09-10T10:00:00Z',
  notes: `Note for ${id}.`,
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
