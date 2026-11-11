import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config.js';
import { FINDING_TYPES, parseSearchParams } from '../../src/core/params.js';
import { createApp } from '../../src/http/app.js';
import { listen, makePublicDir } from './helpers.js';

// The store is built on another branch. Without it this suite is skipped; a store that exists but fails to
// import still fails the run, which `.catch(() => null)` would hide.
const storeUrl = new URL('../../src/core/store.js', import.meta.url);
const storeModule = existsSync(storeUrl) ? await import(storeUrl.href) : null;

const JSON_TYPE = 'application/json; charset=utf-8';
const HIT_KEYS = [
  'caseIds',
  'duplicateOf',
  'duplicates',
  'entity',
  'flags',
  'highlights',
  'id',
  'notes',
  'observedAt',
  'rawId',
  'sameRawId',
  'score',
  'source',
  'type',
  'typeRaw',
];

describe('HTTP API on the real dataset', { skip: storeModule === null && 'src/core/store.js is not on this branch' }, () => {
  let dataset;
  let store;
  let publicDir;
  let server;

  before(async () => {
    dataset = JSON.parse(readFileSync(new URL('../../findings.json', import.meta.url), 'utf8'));
    store = storeModule.createStore(dataset);
    publicDir = makePublicDir();
    const mcpHandler = () => {
      throw new Error('/mcp is not under test here');
    };
    server = await listen(createApp({ store, config: loadConfig({}), mcpHandler, publicDir: publicDir.dir }));
  });
  after(async () => {
    await server?.close();
    publicDir?.remove();
  });

  async function get(path) {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  }

  /** The store's own answer to the same search, as it looks after JSON serialisation. */
  function direct(input) {
    const parsed = parseSearchParams(input);
    assert.ok(parsed.ok, JSON.stringify(parsed.errors));
    return JSON.parse(JSON.stringify(store.search(parsed.value)));
  }

  /** Every hit for a query string, fetched page by page. */
  async function allHits(query) {
    const hits = [];
    for (let offset = 0; ; offset += 100) {
      const { status, body } = await get(`/api/findings?${query}&limit=100&offset=${offset}`);
      assert.equal(status, 200, query);
      hits.push(...body.results);
      if (offset + 100 >= body.total) return hits;
    }
  }

  test('default search: shape, totals, newest first', async () => {
    const { status, headers, body } = await get('/api/findings');
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(body).sort(), ['facets', 'limit', 'offset', 'results', 'total']);
    assert.equal(body.total, 1002);
    assert.equal(body.limit, 20);
    assert.equal(body.offset, 0);
    assert.equal(body.results.length, 20);
    assert.deepEqual(Object.keys(body.facets.types).sort(), [...FINDING_TYPES].sort());
    assert.equal(Object.values(body.facets.types).reduce((a, b) => a + b, 0), 1002);
    for (const hit of body.results) {
      assert.deepEqual(Object.keys(hit).sort(), HIT_KEYS, `${hit.id}: summary fields only, no raw record`);
      assert.equal(hit.duplicateOf, null, hit.id);
      assert.deepEqual(hit.highlights, { entity: [], notes: [] }, hit.id);
    }
    for (let i = 1; i < body.results.length; i++) {
      assert.ok(body.results[i - 1].observedAt >= body.results[i].observedAt, 'newest first');
    }
    assert.deepEqual(body, direct({}), 'the store answer, verbatim');
  });

  test('includeDuplicates=true adds the 30 linked duplicates', async () => {
    assert.equal((await get('/api/findings?includeDuplicates=true')).body.total, 1032);
    assert.equal((await get('/api/findings?includeDuplicates=1')).body.total, 1032);
    assert.equal((await get('/api/findings?includeDuplicates=false')).body.total, 1002);
  });

  test('q: diacritics and letter case do not matter', async () => {
    const answers = [];
    for (const q of ['sokolaadimees', 'ŠOKOLAADIMEES', 'Šokolaadimees']) {
      const { status, body } = await get(`/api/findings?q=${encodeURIComponent(q)}&limit=100`);
      assert.equal(status, 200, q);
      assert.ok(body.total > 0, q);
      for (const hit of body.results) {
        assert.equal(hit.entity, 'Šokolaadimees', `${q}: ${hit.id}`);
        assert.deepEqual(hit.highlights.entity, [[0, 13]], `${q}: ${hit.id}`);
      }
      assert.deepEqual(body, direct({ query: q, limit: 100 }), q);
      answers.push(body.results.map((hit) => hit.id));
    }
    assert.deepEqual(answers[1], answers[0]);
    assert.deepEqual(answers[2], answers[0]);
  });

  test('type: comma-separated and repeated forms are the same filter; facets ignore it', async () => {
    const comma = await get('/api/findings?type=ip,domain&limit=100');
    const repeated = await get('/api/findings?type=ip&type=domain&limit=100');
    assert.equal(comma.status, 200);
    assert.deepEqual(repeated.body, comma.body);
    const { body } = comma;
    assert.ok(body.total > 0);
    assert.equal(body.total, body.facets.types.ip + body.facets.types.domain);
    for (const hit of body.results) assert.ok(['ip', 'domain'].includes(hit.type), hit.id);
    assert.deepEqual(body.facets, (await get('/api/findings')).body.facets, 'facets are counted before the type filter');
  });

  test('case: one case, either letter case, and unassigned', async () => {
    const c104 = await allHits('case=C-104');
    assert.ok(c104.length > 0);
    for (const hit of c104) assert.ok(hit.caseIds.includes('C-104'), hit.id);
    assert.ok(c104.some((hit) => hit.id === 'F-10906'), 'a finding in two cases is in both');
    assert.deepEqual(
      (await allHits('case=c-104')).map((hit) => hit.id),
      c104.map((hit) => hit.id),
    );
    assert.ok((await allHits('case=C-122')).some((hit) => hit.id === 'F-10906'));
    assert.deepEqual(
      (await allHits('case=unassigned')).map((hit) => hit.id),
      ['F-10767'],
    );
  });

  test('from and to: a bare date is the whole UTC day', async () => {
    const hits = await allHits('from=2026-10-31&to=2026-10-31');
    assert.ok(hits.length > 0);
    for (const hit of hits) assert.ok(hit.observedAt.startsWith('2026-10-31T'), `${hit.id} ${hit.observedAt}`);
    assert.equal(hits[0].observedAt, '2026-10-31T22:18:34.000Z', 'the newest observation in the dataset comes first');
  });

  test('GET /api/findings/:id: both findings that share a raw id are addressable', async () => {
    const second = await get('/api/findings/F-10578-2');
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('content-type'), JSON_TYPE);
    assert.equal(second.body.type, 'domain');
    assert.equal(second.body.entity, 'sable-nimbus.test');
    assert.deepEqual(second.body.caseIds, ['C-116']);
    assert.ok(second.body.flags.includes('duplicate_id'));
    assert.deepEqual(second.body.sameRawId, ['F-10578']);
    assert.deepEqual(second.body.raw, dataset.findings.filter((r) => r.id === 'F-10578')[1], 'the original record');

    const first = await get('/api/findings/F-10578');
    assert.equal(first.body.type, 'wallet');
    assert.deepEqual(first.body.sameRawId, ['F-10578-2']);
  });

  test('GET /api/findings/:id ignores letter case', async () => {
    const { status, body } = await get('/api/findings/f-10327');
    assert.equal(status, 200);
    assert.equal(body.id, 'F-10327');
    assert.equal(body.observedAt, '2026-09-10T11:11:30.000Z');
  });

  test('GET /api/findings/:id: a duplicate is still returned, pointing at its canonical finding', async () => {
    const { status, body } = await get('/api/findings/F-20028');
    assert.equal(status, 200);
    assert.equal(body.duplicateOf, 'F-10845');
    assert.ok(body.flags.includes('reingested_duplicate'));
  });

  test('GET /api/findings/:id for an unknown id gets 404', async () => {
    const { status, headers, body } = await get('/api/findings/nope');
    assert.equal(status, 404);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(body, { error: { code: 'not_found', message: 'No finding with id nope' } });
  });

  test('a hostile note comes back verbatim, as JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/findings/F-10062`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), JSON_TYPE);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const finding = JSON.parse(text);
    assert.equal(finding.notes, "<script>alert('escape your output')</script>");
    assert.equal(finding.raw.notes, "<script>alert('escape your output')</script>");
    assert.ok(finding.flags.includes('notes_markup'));
    assert.ok(text.includes(`"notes":${JSON.stringify(finding.notes)}`), 'a JSON string, not decoded or re-encoded');
  });

  test('GET /api/cases: 40 cases in order, plus the unassigned count', async () => {
    const { status, headers, body } = await get('/api/cases');
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(body).sort(), ['cases', 'unassigned']);
    assert.deepEqual(
      body.cases.map((c) => c.caseId),
      Array.from({ length: 40 }, (_, i) => `C-${101 + i}`),
    );
    for (const c of body.cases) {
      assert.deepEqual(
        Object.keys(c).sort(),
        ['caseId', 'duplicateCount', 'findingCount', 'firstObservedAt', 'lastObservedAt', 'types'],
        c.caseId,
      );
      assert.deepEqual(Object.keys(c.types).sort(), [...FINDING_TYPES].sort(), c.caseId);
      assert.ok(c.firstObservedAt <= c.lastObservedAt, c.caseId);
    }
    assert.equal(body.cases.reduce((sum, c) => sum + c.findingCount, 0), 1002);
    assert.equal(body.cases.reduce((sum, c) => sum + c.duplicateCount, 0), 30);
    assert.deepEqual(body.unassigned, { findingCount: 1 });
    assert.deepEqual(body, JSON.parse(JSON.stringify(store.listCases())), 'the store answer, verbatim');
  });

  test('GET /healthz counts every finding, duplicates included', async () => {
    const { status, body } = await get('/healthz');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok', findings: 1032 });
  });

  test('limit=101 gets 400 on limit', async () => {
    const { status, headers, body } = await get('/api/findings?limit=101');
    assert.equal(status, 400);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.equal(body.error.code, 'invalid_params');
    assert.equal(body.error.details[0].param, 'limit');
  });

  test('type=banana gets 400 on type', async () => {
    const { status, body } = await get('/api/findings?type=banana');
    assert.equal(status, 400);
    assert.deepEqual(
      body.error.details.map((detail) => detail.param),
      ['type'],
    );
  });

  test('unknown query parameters are ignored', async () => {
    const { status, body } = await get('/api/findings?foo=bar&query=zzzzqqq&types=banana');
    assert.equal(status, 200);
    assert.deepEqual(body, (await get('/api/findings')).body);
  });

  test('a malformed percent-encoding in a finding id gets 400', async () => {
    const { status, body } = await get('/api/findings/%E0%A4%A');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_params');
  });

  test('an unsafe source gets no href', async () => {
    const { status, body } = await get('/api/findings/F-10968');
    assert.equal(status, 200);
    assert.deepEqual(body.source, { raw: "javascript:alert('check your links')", href: null, status: 'unsafe' });
    assert.ok(body.flags.includes('source_unsafe'));
  });
});
