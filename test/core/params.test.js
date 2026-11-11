import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchParams, FINDING_TYPES } from '../../src/core/params.js';

const DEFAULTS = {
  query: '',
  types: [],
  caseId: null,
  from: null,
  to: null,
  limit: 20,
  offset: 0,
  includeDuplicates: false,
};

function ok(input) {
  const result = parseSearchParams(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.value;
}

/** Asserts failure and returns the params that were reported, in order. */
function failed(input) {
  const result = parseSearchParams(input);
  assert.equal(result.ok, false, `expected errors for ${JSON.stringify(input)}`);
  for (const e of result.errors) {
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 0);
  }
  return result.errors.map((e) => e.param);
}

test('empty input gives the defaults', () => {
  assert.deepEqual(ok({}), DEFAULTS);
});

test('empty strings (HTTP form of "not set") give the defaults', () => {
  assert.deepEqual(
    ok({ query: '', types: '', caseId: '', from: '', to: '', limit: '', offset: '', includeDuplicates: '' }),
    DEFAULTS,
  );
});

test('a non-object input is a programming error', () => {
  for (const input of [undefined, null, [], 'q']) {
    assert.throws(() => parseSearchParams(input), TypeError);
  }
});

test('query', () => {
  assert.equal(ok({ query: '  õngitsus  ' }).query, 'õngitsus');
  assert.equal(ok({ query: 'x'.repeat(200) }).query.length, 200);
  assert.equal(ok({ query: `  ${'x'.repeat(200)}  ` }).query.length, 200, 'length is checked after trimming');
  assert.deepEqual(failed({ query: 'x'.repeat(201) }), ['query']);
  for (const query of [42, null, ['a'], { a: 1 }, true]) {
    assert.deepEqual(failed({ query }), ['query'], JSON.stringify(query));
  }
});

test('types: string form', () => {
  assert.deepEqual(ok({ types: 'ip, Domain' }).types, ['domain', 'ip']);
  assert.deepEqual(ok({ types: 'wallet' }).types, ['wallet']);
  assert.deepEqual(ok({ types: 'IP,ip, ip ' }).types, ['ip'], 'deduped');
  assert.deepEqual(ok({ types: ',ip,' }).types, ['ip'], 'empty items from joined repeats are ignored');
  assert.deepEqual(ok({ types: FINDING_TYPES.toReversed().join(',') }).types, FINDING_TYPES);
  assert.deepEqual(failed({ types: 'banana' }), ['types']);
  assert.deepEqual(failed({ types: 'ip,banana' }), ['types']);
});

test('types: typed form', () => {
  assert.deepEqual(ok({ types: ['ip', ' Domain '] }).types, ['domain', 'ip']);
  assert.deepEqual(ok({ types: ['unknown', 'email', 'email'] }).types, ['email', 'unknown']);
  assert.deepEqual(ok({ types: [] }).types, []);
  assert.deepEqual(failed({ types: ['banana'] }), ['types']);
  assert.deepEqual(failed({ types: ['ip,domain'] }), ['types'], 'array items are single values');
  assert.deepEqual(failed({ types: [''] }), ['types']);
  for (const types of [42, null, [1], { ip: true }]) {
    assert.deepEqual(failed({ types }), ['types'], JSON.stringify(types));
  }
});

test('types: the error lists the allowed values', () => {
  const { errors } = parseSearchParams({ types: 'banana' });
  for (const t of FINDING_TYPES) assert.match(errors[0].message, new RegExp(`\\b${t}\\b`));
});

test('caseId', () => {
  assert.equal(ok({ caseId: 'C-104' }).caseId, 'C-104');
  assert.equal(ok({ caseId: ' c-104 ' }).caseId, 'C-104');
  assert.equal(ok({ caseId: 'unassigned' }).caseId, 'unassigned');
  assert.equal(ok({ caseId: 'UNASSIGNED' }).caseId, 'unassigned');
  assert.equal(ok({ caseId: ' Unassigned ' }).caseId, 'unassigned');
  for (const caseId of ['C-', 'X-1', 'C-1a', 'C104', '104', 'none', 104, null, ['C-104']]) {
    assert.deepEqual(failed({ caseId }), ['caseId'], JSON.stringify(caseId));
  }
});

test('from and to: date-only bounds cover the whole UTC day', () => {
  const v = ok({ from: '2026-09-10', to: '2026-09-10' });
  assert.equal(v.from, Date.parse('2026-09-10T00:00:00.000Z'));
  assert.equal(v.to, Date.parse('2026-09-10T23:59:59.999Z'));
});

test('from and to: date-times need a zone and are converted to UTC', () => {
  const v = ok({ from: '2026-09-10T14:11:30+03:00', to: '2026-09-22T14:33:32Z' });
  assert.equal(v.from, Date.parse('2026-09-10T11:11:30Z'));
  assert.equal(v.to, Date.parse('2026-09-22T14:33:32Z'));
  assert.equal(ok({ from: '2026-09-10T14:11Z' }).from, Date.parse('2026-09-10T14:11:00Z'));
  assert.equal(ok({ from: '2026-09-10T14:11:30.250-02:30' }).from, Date.parse('2026-09-10T16:41:30.250Z'));
  assert.equal(ok({ from: ' 2026-09-10 ' }).from, Date.parse('2026-09-10T00:00:00Z'));
});

test('from and to: wrong format', () => {
  for (const bound of [
    '2026-09-10T14:11:30', // no zone
    '2026-9-10',
    '10.09.2026',
    '2026-09-10 14:11:30Z',
    '2026-09-10T14:11:30+0300',
    'yesterday',
    1789205400000,
    null,
  ]) {
    assert.deepEqual(failed({ from: bound }), ['from'], JSON.stringify(bound));
    assert.deepEqual(failed({ to: bound }), ['to'], JSON.stringify(bound));
  }
});

test('from and to: invalid dates in the right format', () => {
  for (const bound of [
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-09-00',
    '2026-09-10T24:00:00Z',
    '2026-09-10T23:60:00Z',
    '2026-09-10T23:59:60Z',
    '2026-09-10T12:00:00+24:00',
  ]) {
    assert.deepEqual(failed({ from: bound }), ['from'], bound);
  }
  assert.equal(ok({ from: '2028-02-29' }).from, Date.parse('2028-02-29T00:00:00Z'), 'leap day');
});

test('from > to is reported on to', () => {
  assert.deepEqual(failed({ from: '2026-09-11', to: '2026-09-10' }), ['to']);
  assert.deepEqual(failed({ from: '2026-09-10T00:00:00.001Z', to: '2026-09-10T00:00:00Z' }), ['to']);
  assert.deepEqual(failed({ from: 'bad', to: '2026-09-10' }), ['from'], 'no ordering error when a bound is invalid');
});

test('from and to: either bound alone', () => {
  assert.deepEqual(ok({ from: '2026-09-10' }).to, null);
  assert.deepEqual(ok({ to: '2026-09-10' }).from, null);
});

test('limit', () => {
  assert.equal(ok({ limit: '1' }).limit, 1);
  assert.equal(ok({ limit: 100 }).limit, 100);
  assert.equal(ok({ limit: ' 50 ' }).limit, 50);
  for (const limit of [0, '0', 101, '101', 1.5, '1.5', 'abc', '-1', '1e2', null, true, NaN, Infinity]) {
    assert.deepEqual(failed({ limit }), ['limit'], String(limit));
  }
});

test('offset', () => {
  assert.equal(ok({ offset: '0' }).offset, 0);
  assert.equal(ok({ offset: 100000 }).offset, 100000);
  assert.equal(ok({ offset: '40' }).offset, 40);
  for (const offset of [-1, '-1', 100001, '100001', 2.5, 'abc', null, false]) {
    assert.deepEqual(failed({ offset }), ['offset'], String(offset));
  }
});

test('includeDuplicates', () => {
  for (const v of [true, 'true', '1']) assert.equal(ok({ includeDuplicates: v }).includeDuplicates, true);
  for (const v of [false, 'false', '0']) assert.equal(ok({ includeDuplicates: v }).includeDuplicates, false);
  for (const v of ['yes', 'TRUE', 1, 0, null, 'on']) {
    assert.deepEqual(failed({ includeDuplicates: v }), ['includeDuplicates'], String(v));
  }
});

test('unknown keys are rejected', () => {
  assert.deepEqual(failed({ query: 'x', bogus: 1 }), ['bogus']);
  assert.deepEqual(failed({ q: 'x' }), ['q'], 'HTTP names are mapped by the caller, not here');
  assert.deepEqual(failed(JSON.parse('{"__proto__": {"limit": 5}}')), ['__proto__']);
  const { errors } = parseSearchParams({ bogus: 1 });
  assert.equal(errors[0].message, 'unknown parameter');
});

test('all errors are reported together', () => {
  const params = failed({
    query: 42,
    types: 'banana',
    caseId: 'X-1',
    from: 'yesterday',
    to: '2026-02-30',
    limit: 0,
    offset: -1,
    includeDuplicates: 'maybe',
    extra: true,
  });
  assert.deepEqual(params, ['query', 'types', 'caseId', 'from', 'to', 'limit', 'offset', 'includeDuplicates', 'extra']);
});

test('a full valid request in string and typed form gives the same value', () => {
  const expected = {
    query: 'phishing',
    types: ['domain', 'ip'],
    caseId: 'C-104',
    from: Date.parse('2026-09-01T00:00:00.000Z'),
    to: Date.parse('2026-09-30T23:59:59.999Z'),
    limit: 50,
    offset: 50,
    includeDuplicates: true,
  };
  assert.deepEqual(
    ok({ query: ' phishing ', types: 'ip,domain', caseId: 'c-104', from: '2026-09-01', to: '2026-09-30', limit: '50', offset: '50', includeDuplicates: 'true' }),
    expected,
  );
  assert.deepEqual(
    ok({ query: 'phishing', types: ['ip', 'domain'], caseId: 'C-104', from: '2026-09-01', to: '2026-09-30', limit: 50, offset: 50, includeDuplicates: true }),
    expected,
  );
});

test('the input is not mutated', () => {
  const input = { query: ' x ', types: ['IP'], limit: '5' };
  const before = JSON.stringify(input);
  ok(input);
  assert.equal(JSON.stringify(input), before);
});
