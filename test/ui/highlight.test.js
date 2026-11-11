import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDING_TYPES, splitByRanges, safeHref, buildSearchQuery } from '../../public/highlight.js';
import { FINDING_TYPES as CORE_TYPES, parseSearchParams } from '../../src/core/params.js';

test('the UI offers the same types, in the same order, as the core', () => {
  assert.deepEqual(FINDING_TYPES, CORE_TYPES);
});

const joined = (parts) => parts.map((p) => p.text).join('');
const hits = (parts) => parts.filter((p) => p.hit).map((p) => p.text);

test('splitByRanges without ranges returns the text as one plain part', () => {
  assert.deepEqual(splitByRanges('abc', []), [{ text: 'abc', hit: false }]);
  assert.deepEqual(splitByRanges('abc', undefined), [{ text: 'abc', hit: false }]);
  assert.deepEqual(splitByRanges('', [[0, 1]]), []);
});

test('splitByRanges marks one range', () => {
  assert.deepEqual(splitByRanges('Kasutaja märgiti', [[9, 16]]), [
    { text: 'Kasutaja ', hit: false },
    { text: 'märgiti', hit: true },
  ]);
  assert.deepEqual(splitByRanges('abc', [[0, 3]]), [{ text: 'abc', hit: true }]);
});

test('splitByRanges merges adjacent and overlapping ranges', () => {
  assert.deepEqual(splitByRanges('abcdef', [[0, 2], [2, 4]]), [
    { text: 'abcd', hit: true },
    { text: 'ef', hit: false },
  ]);
  assert.deepEqual(splitByRanges('abcdef', [[3, 5], [1, 4]]), [
    { text: 'a', hit: false },
    { text: 'bcde', hit: true },
    { text: 'f', hit: false },
  ]);
  assert.deepEqual(hits(splitByRanges('abcdef', [[1, 5], [2, 3]])), ['bcde']);
});

test('splitByRanges keeps separate ranges apart', () => {
  assert.deepEqual(splitByRanges('ab cd ef', [[6, 8], [0, 2]]), [
    { text: 'ab', hit: true },
    { text: ' cd ', hit: false },
    { text: 'ef', hit: true },
  ]);
});

test('splitByRanges clamps out-of-bounds ranges and drops the rest', () => {
  assert.deepEqual(hits(splitByRanges('abc', [[-5, 1]])), ['a']);
  assert.deepEqual(hits(splitByRanges('abc', [[2, 99]])), ['c']);
  assert.deepEqual(splitByRanges('abc', [[3, 9], [10, 12]]), [{ text: 'abc', hit: false }]);
});

test('splitByRanges ignores reversed, empty and non-integer ranges', () => {
  const plain = [{ text: 'abcdef', hit: false }];
  assert.deepEqual(splitByRanges('abcdef', [[4, 2]]), plain);
  assert.deepEqual(splitByRanges('abcdef', [[2, 2]]), plain);
  assert.deepEqual(splitByRanges('abcdef', [[1.5, 3], [0, '2'], [NaN, 4], [1], null, 'x', [0, Infinity]]), plain);
  assert.deepEqual(splitByRanges('abcdef', 'nonsense'), plain);
});

test('splitByRanges passes markup through as plain text', () => {
  const text = "<mark>already highlighted</mark> <script>alert('x')</script> 5 &lt; 10";
  const parts = splitByRanges(text, [[6, 13], [33, 41]]);
  assert.equal(joined(parts), text);
  assert.deepEqual(hits(parts), ['already', '<script>']);
});

test('splitByRanges parts always concatenate to the input', () => {
  // Deterministic pseudo-random ranges, including junk, over text with astral and combining characters.
  const text = 'Šokolaadimees 🦉 õngitsus šx 0xc008';
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 500; round++) {
    const ranges = Array.from({ length: rand(6) }, () => [rand(text.length + 6) - 3, rand(text.length + 6) - 3]);
    const parts = splitByRanges(text, ranges);
    assert.equal(joined(parts), text);
    for (let i = 1; i < parts.length; i++) assert.notEqual(parts[i].hit, parts[i - 1].hit, 'neighbouring parts alternate');
    for (const part of parts) assert.ok(part.text.length > 0);
  }
});

test('safeHref returns http and https links', () => {
  assert.equal(safeHref({ raw: 'https://chat.example/1', href: 'https://chat.example/1', status: 'ok' }), 'https://chat.example/1');
  assert.equal(
    safeHref({ raw: 'http://forum.example/x?utm_source=a', href: 'http://forum.example/x?utm_source=a', status: 'ok' }),
    'http://forum.example/x?utm_source=a',
  );
  assert.equal(
    safeHref({ raw: 'forum.example/thread/88', href: 'https://forum.example/thread/88', status: 'scheme_assumed' }),
    'https://forum.example/thread/88',
  );
});

test('safeHref returns the parsed URL, not the input', () => {
  assert.equal(safeHref({ href: 'HTTP://Forum.Example/x' }), 'http://forum.example/x');
  assert.equal(safeHref({ href: 'http:forum.example' }), 'http://forum.example/');
});

test('safeHref refuses everything that is not an absolute http(s) URL', () => {
  const refused = [
    "javascript:alert('check your links')",
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\tjava\nscript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'vbscript:x',
    'file:///etc/passwd',
    'forum.example/thread/88',
    '//evil.example',
    '/relative',
    'http://',
    '',
    null,
    42,
    { toString: () => 'https://chat.example/' },
  ];
  for (const href of refused) assert.equal(safeHref({ raw: 'x', href, status: 'ok' }), null, String(href));
});

test('safeHref ignores a forged status', () => {
  assert.equal(safeHref({ raw: 'javascript:alert(1)', href: 'javascript:alert(1)', status: 'ok' }), null);
});

test('safeHref handles a missing source', () => {
  assert.equal(safeHref(null), null);
  assert.equal(safeHref(undefined), null);
  assert.equal(safeHref({}), null);
  assert.equal(safeHref({ raw: '', href: null, status: 'missing' }), null);
});

test('buildSearchQuery omits empty values', () => {
  assert.equal(buildSearchQuery({}), '');
  assert.equal(buildSearchQuery({ q: '', types: [], case: '', from: '', to: '', dups: false, offset: 0 }), '');
  assert.equal(buildSearchQuery({ q: 'ongitsus' }), 'q=ongitsus');
  assert.equal(buildSearchQuery({ q: '', offset: 20 }), 'offset=20');
});

test('buildSearchQuery maps every field to the API parameter name', () => {
  const query = buildSearchQuery({
    q: 'õngitsus & co #1 100%', types: ['domain', 'ip'], case: 'C-104', from: '2026-10-01', to: '2026-10-31', dups: true, offset: 40,
  });
  assert.equal(
    query,
    'q=%C3%B5ngitsus%20%26%20co%20%231%20100%25&type=domain,ip&case=C-104&from=2026-10-01&to=2026-10-31&includeDuplicates=true&offset=40',
  );
  const params = new URLSearchParams(query);
  assert.equal(params.get('q'), 'õngitsus & co #1 100%');
  assert.equal(params.get('type'), 'domain,ip');
});

test('buildSearchQuery survives a lone surrogate', () => {
  assert.equal(new URLSearchParams(buildSearchQuery({ q: 'a\uD800b' })).get('q'), 'a�b');
});

test('buildSearchQuery output is accepted by the shared parameter validator', () => {
  // The same mapping as GET /api/findings (implementation plan 4.3).
  const names = { q: 'query', type: 'types', case: 'caseId' };
  const toInput = (query) => Object.fromEntries([...new URLSearchParams(query)].map(([k, v]) => [names[k] ?? k, v]));
  const parsed = parseSearchParams(toInput(buildSearchQuery({
    q: ' Šokolaadimees ', types: ['handle', 'alias'], case: 'unassigned', from: '2026-09-01', to: '2026-09-30', dups: true, offset: 20,
  })));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    query: 'Šokolaadimees',
    types: ['handle', 'alias'],
    caseId: 'unassigned',
    from: Date.parse('2026-09-01T00:00:00.000Z'),
    to: Date.parse('2026-09-30T23:59:59.999Z'),
    limit: 20,
    offset: 20,
    includeDuplicates: true,
  });
});
