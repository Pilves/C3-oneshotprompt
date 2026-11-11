import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectShape, normalizeType, normalizeCaseIds, normalizeObservedAt, normalizeSource } from '../../src/core/normalize.js';

test('detectShape', () => {
  const cases = [
    ['0x502ed0bf2a35bc83220658a70a09f2d4b69fc2d0', 'wallet'],
    ['0xCC2B8AF0945E2FC46653EF6BADACC21AB79CB2A4', 'wallet'],
    ['0x502ed0bf2a35bc83220658a70a09f2d4b69fc2d', null], // 39 hex digits
    ['0x502ed0bf2a35bc83220658a70a09f2d4b69fc2dg', null],
    ['192.0.2.14', 'ip'],
    ['2001:db8::1', 'ip'],
    ['256.1.1.1', null],
    ['1.2.3', null],
    ['harbor.sable@raven-tundra.test', 'email'],
    ['HARBOR.SABLE@RAVEN-TUNDRA.TEST', 'email'],
    ['a@b', null],
    ['tundra-ember.test', 'domain'],
    ['Sub.Example.COM', 'domain'],
    ['localhost', null],
    ['-bad.test', null],
    ['a..test', null],
    ['example.123', null],
    [`${'a'.repeat(63)}.`.repeat(4) + 'test', null], // 260 characters
    ['zephyr_raven92', null],
    ['Šokolaadimees', null],
  ];
  for (const [entity, shape] of cases) assert.equal(detectShape(entity), shape, entity);
});

test('type: the seven non-canonical labels in the dataset', () => {
  const rows = [
    ['F-10917', ' email ', 'tundra.pixel@harbor-drift.test', 'email', false],
    ['F-10788', 'ipv4', 'tundra-ember.test', 'domain', true],
    ['F-10819', 'Domain', '192.0.2.14', 'ip', true],
    ['F-10142', 'url', 'zephyr.nimbus@salt-flat.test', 'email', true],
    ['F-10380', 'Handle', 'vortex.raven@nimbus-salt.test', 'email', true],
    ['F-10582', 'IP', 'zephyr_raven92', 'unknown', true],
    ['F-10276', 'ALIAS', 'cobalt_harbor31', 'alias', false],
  ];
  for (const [id, label, entity, type, mismatch] of rows) {
    assert.deepEqual(normalizeType(label, entity), { type, mismatch }, id);
  }
});

test('type: labels that agree with the value', () => {
  assert.deepEqual(normalizeType('ip', '198.51.100.7'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('ipv4', '198.51.100.7'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('IPv6', '2001:db8::1'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('ip', '2001:db8::1'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('wallet', '0x502ed0bf2a35bc83220658a70a09f2d4b69fc2d0'), { type: 'wallet', mismatch: false });
  assert.deepEqual(normalizeType('handle', 'pixel_ember17'), { type: 'handle', mismatch: false });
});

test('type: a label without checkable syntax is trusted', () => {
  assert.deepEqual(normalizeType('wallet', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), { type: 'wallet', mismatch: false });
  assert.deepEqual(normalizeType('alias', 'Šokolaadimees'), { type: 'alias', mismatch: false });
});

test('type: a label that the value contradicts', () => {
  assert.deepEqual(normalizeType('domain', 'not a domain'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('email', 'pixel_ember17'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('handle', '198.51.100.7'), { type: 'ip', mismatch: true });
  assert.deepEqual(normalizeType('ipv4', '2001:db8::1'), { type: 'ip', mismatch: false }, 'ipv4/ipv6 are both just ip');
});

test('type: missing or unknown label', () => {
  assert.deepEqual(normalizeType('', 'zephyr_raven92'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('person', 'zephyr_raven92'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('', 'tundra-ember.test'), { type: 'domain', mismatch: true });
  assert.deepEqual(normalizeType('unknown', 'zephyr_raven92'), { type: 'unknown', mismatch: false }, 'the label already says unknown');
});

test('type: empty entity is unknown without a mismatch (entity_missing covers it)', () => {
  assert.deepEqual(normalizeType('ip', ''), { type: 'unknown', mismatch: false });
});

test('case ids', () => {
  const rows = [
    [' c-117', ['C-117'], []], // F-10335
    ['C-104', ['C-104'], []],
    [['C-104', 'C-122'], ['C-104', 'C-122'], ['multi_case']], // F-10906
    [['C-122', 'C-104'], ['C-104', 'C-122'], ['multi_case']],
    [['C-104', ' c-104 '], ['C-104'], []],
    [['C-10', 'C-9', 'C-100'], ['C-9', 'C-10', 'C-100'], ['multi_case']],
    [null, [], ['case_missing']], // F-10767
    [undefined, [], ['case_missing']],
    [[], [], ['case_missing']],
    ['X-1', [], ['case_missing', 'case_invalid']],
    ['C-', [], ['case_missing', 'case_invalid']],
    ['', [], ['case_missing', 'case_invalid']],
    [42, [], ['case_missing', 'case_invalid']],
    [{ id: 'C-104' }, [], ['case_missing', 'case_invalid']],
    [['C-104', 'nope', 7], ['C-104'], ['case_invalid']],
    [['C-122', 'bad', 'C-9'], ['C-9', 'C-122'], ['case_invalid', 'multi_case']],
  ];
  for (const [value, caseIds, flags] of rows) {
    assert.deepEqual(normalizeCaseIds(value), { caseIds, flags }, JSON.stringify(value));
  }
});

test('observedAt: valid forms become UTC ISO strings with milliseconds', () => {
  const rows = [
    ['2026-09-02T19:26:14Z', '2026-09-02T19:26:14.000Z'],
    ['2026-09-10T14:11:30+03:00', '2026-09-10T11:11:30.000Z'], // F-10327
    ['2026-11-02T08:00:00+02:00', '2026-11-02T06:00:00.000Z'],
    ['2026-09-10T14:11:30.25-02:30', '2026-09-10T16:41:30.250Z'],
    ['2026-09-10T14:11Z', '2026-09-10T14:11:00.000Z'],
    [' 2026-09-10T14:11:30Z ', '2026-09-10T14:11:30.000Z'],
    [1789624672000, '2026-09-17T05:57:52.000Z'], // epoch ms, F-10142
    [1789624672, '2026-09-17T05:57:52.000Z'], // epoch seconds
    ['1789624672000', '2026-09-17T05:57:52.000Z'],
    ['1789624672', '2026-09-17T05:57:52.000Z'],
    [1789624672000.7, '2026-09-17T05:57:52.000Z'],
  ];
  for (const [value, iso] of rows) {
    assert.deepEqual(normalizeObservedAt(value), { iso, ms: Date.parse(iso), flags: [] }, JSON.stringify(value));
  }
});

test('observedAt: anything else is time_invalid', () => {
  const invalid = { iso: null, ms: null, flags: ['time_invalid'] };
  for (const value of [
    'yesterday',
    '2026-09-10T14:11:30', // no zone: guessing one would shift the instant by hours
    '2026-09-10',
    '2026-09-10 14:11:30Z',
    '2026-09-10T14:11:30+0300',
    '2026-02-30T10:00:00Z',
    '2026-09-10T24:00:00Z',
    '2026-09-10T23:60:00Z',
    '2026-09-10T12:00:00+24:00',
    '',
    '-1789624672',
    '1e12',
    null,
    undefined,
    NaN,
    Infinity,
    1e300,
    true,
    [1789624672000],
    { at: 1789624672000 },
  ]) {
    assert.deepEqual(normalizeObservedAt(value), invalid, String(value));
  }
});

test('source: the anomalies in the dataset', () => {
  assert.deepEqual(normalizeSource('data:text/html,<h1>hi</h1>').source, { raw: 'data:text/html,<h1>hi</h1>', href: null, status: 'unsafe' }); // F-10748
  assert.deepEqual(normalizeSource("javascript:alert('check your links')").flags, ['source_unsafe']); // F-10968
  assert.deepEqual(normalizeSource('forum.example/thread/88'), { // F-10930
    source: { raw: 'forum.example/thread/88', href: 'https://forum.example/thread/88', status: 'scheme_assumed' },
    flags: ['source_scheme_assumed'],
    dedupeKey: 'https://forum.example/thread/88',
  });
  assert.deepEqual(normalizeSource(''), { source: { raw: '', href: null, status: 'missing' }, flags: ['source_missing'], dedupeKey: '' }); // F-10381
});

test('source: ordinary http(s) URLs are links, as collected', () => {
  const tracked = 'https://chat.example/65984?utm_source=telegram&utm_medium=share';
  assert.deepEqual(normalizeSource(tracked).source, { raw: tracked, href: tracked, status: 'ok' });
  assert.deepEqual(normalizeSource(tracked).flags, []);
  assert.deepEqual(normalizeSource('HTTP://Forum.Example/x').source, { raw: 'HTTP://Forum.Example/x', href: 'http://forum.example/x', status: 'ok' });
  assert.equal(normalizeSource(' https://forum.example/1 ').source.raw, ' https://forum.example/1 ', 'raw is untrimmed');
  assert.equal(normalizeSource(' https://forum.example/1 ').source.href, 'https://forum.example/1');
});

test('source: a host and port without a scheme is not mistaken for a scheme', () => {
  assert.deepEqual(normalizeSource('forum.example:8080/x').source, { raw: 'forum.example:8080/x', href: 'https://forum.example:8080/x', status: 'scheme_assumed' });
});

test('source: other schemes are never links', () => {
  for (const value of ['file:///etc/passwd', 'vbscript:x', ' javascript:alert(1)', 'JavaScript:alert(1)', 'mailto:a@b.example', 'localhost:8080']) {
    const { source, flags } = normalizeSource(value);
    assert.deepEqual(source, { raw: value, href: null, status: 'unsafe' }, value);
    assert.deepEqual(flags, ['source_unsafe']);
  }
});

test('source: invalid and missing', () => {
  for (const value of ['http://', 'https://exa mple.example/', 'not a url', '//evil.example/x', '/relative/path', 'forum example/x']) {
    const { source, flags } = normalizeSource(value);
    assert.deepEqual(source, { raw: value, href: null, status: 'invalid' }, value);
    assert.deepEqual(flags, ['source_invalid']);
  }
  for (const value of [undefined, null, 42, ['https://forum.example/1'], '   ']) {
    const { source, flags } = normalizeSource(value);
    assert.equal(source.status, 'missing', String(value));
    assert.equal(source.href, null);
    assert.deepEqual(flags, ['source_missing']);
  }
  assert.equal(normalizeSource(42).source.raw, '');
  assert.equal(normalizeSource('   ').source.raw, '   ');
});

test('source: the duplicate key ignores tracking parameters, fragments and trailing slashes', () => {
  const key = (value) => normalizeSource(value).dedupeKey;
  const base = key('https://chat.example/65984');
  assert.equal(base, 'https://chat.example/65984');
  for (const same of [
    'https://chat.example/65984?utm_source=telegram&utm_medium=share',
    'https://chat.example/65984/',
    'https://chat.example/65984//',
    'https://CHAT.example/65984#top',
    'https://chat.example/65984?UTM_Campaign=x',
  ]) {
    assert.equal(key(same), base, same);
  }
  assert.notEqual(key('https://chat.example/65985'), base);
  assert.notEqual(key('http://chat.example/65984'), base);
  assert.equal(key('https://chat.example/'), 'https://chat.example/');
  assert.equal(key('https://chat.example/x?a=b%20c&utm_source=t'), key('https://chat.example/x?a=b+c'));
  assert.notEqual(key('https://chat.example/x?a=1'), key('https://chat.example/x?a=2'));
  assert.equal(key(' javascript:alert(1) '), 'javascript:alert(1)', 'without an href the key is the trimmed text');
});
