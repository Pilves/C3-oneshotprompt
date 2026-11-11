import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { META, SERVER_INFO } from '../../src/mcp/protocol.js';
import { createMcpHandler } from '../../src/mcp/handler.js';
import { INSTRUCTIONS } from '../../src/mcp/tools.js';

const ENVELOPE = {
  [META.protocolVersion]: '2026-07-28',
  [META.clientCapabilities]: {},
  [META.clientInfo]: { name: 'methods-test', version: '0' },
};

const FINDING = {
  id: 'F-1',
  rawId: 'F-1',
  type: 'ip',
  typeRaw: 'ip',
  entity: '198.51.100.7',
  caseIds: ['C-101'],
  observedAt: '2026-09-11T08:00:00.000Z',
  notes: 'Observed beaconing.',
  source: { raw: 'https://archive.example/1', href: 'https://archive.example/1', status: 'ok' },
  flags: [],
  duplicateOf: null,
  duplicates: [],
  sameRawId: [],
};

const FAKE_STORE = {
  search: (params) => ({
    total: 1,
    limit: params.limit,
    offset: params.offset,
    results: [{ ...FINDING, score: 3, highlights: { entity: [[0, 3]], notes: [] } }],
    facets: { types: {} },
  }),
  getFinding: (id) => (typeof id === 'string' && id.trim().toUpperCase() === 'F-1' ? { ...FINDING, raw: { id: 'F-1' } } : null),
  listCases: () => ({
    cases: [{ caseId: 'C-101', findingCount: 1, duplicateCount: 0, types: {}, firstObservedAt: null, lastObservedAt: null }],
    unassigned: { findingCount: 0 },
  }),
  stats: {},
};

const servers = [];
after(() => {
  for (const { server, handler } of servers) {
    handler.close?.();
    server.closeAllConnections();
    server.close();
  }
});

/** Starts a handler on port 0 and returns an `rpc` bound to it. */
async function start({ store = FAKE_STORE, config = { mcpRateLimitPerMinute: 0 }, ...rest } = {}) {
  const handler = createMcpHandler({ store, config, ...rest });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, handler });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  async function rpc(method, params = {}, { id = 1, headers = {}, omitHeaders = [] } = {}) {
    const requestHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(method === 'tools/call' && typeof params.name === 'string' && { 'Mcp-Name': params.name }),
      ...headers,
    };
    for (const name of omitHeaders) delete requestHeaders[name];
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: ENVELOPE } });
    const res = await fetch(url, { method: 'POST', headers: requestHeaders, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: JSON.parse(text) };
  }
  return { url, handler, rpc };
}

const shared = start();

function assertResult(response, id = 1) {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.body.jsonrpc, '2.0');
  assert.equal(response.body.id, id);
  assert.equal('error' in response.body, false, response.text);
  const { result } = response.body;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result._meta[META.serverInfo], SERVER_INFO);
  return result;
}

function assertError(response, status, code, id = 1) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.body.id, id);
  assert.equal(response.body.error.code, code, response.text);
}

test('server/discover returns exactly the documented fields', async () => {
  const { rpc } = await shared;
  const result = assertResult(await rpc('server/discover'));
  assert.deepEqual(Object.keys(result).sort(), ['_meta', 'cacheScope', 'capabilities', 'instructions', 'resultType', 'supportedVersions', 'ttlMs']);
  assert.deepEqual(result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal('listChanged' in result.capabilities.tools, false);
  assert.equal(result.instructions, INSTRUCTIONS);
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0);
  assert.ok(['public', 'private'].includes(result.cacheScope));
  const serverInfo = result._meta[META.serverInfo];
  assert.equal(typeof serverInfo.name, 'string');
  assert.equal(typeof serverInfo.version, 'string');
});

test('tools/list carries cache hints and is byte-identical across calls', async () => {
  const { rpc } = await shared;
  const first = await rpc('tools/list');
  const result = assertResult(first);
  assert.ok(Array.isArray(result.tools));
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0);
  assert.ok(['public', 'private'].includes(result.cacheScope));
  assert.equal('nextCursor' in result, false);
  const second = await rpc('tools/list');
  assert.equal(JSON.stringify(second.body.result.tools), JSON.stringify(result.tools));
});

test('tools/list with a cursor → -32602', async () => {
  const { rpc } = await shared;
  const response = await rpc('tools/list', { cursor: 'abc' });
  assertError(response, 200, -32602);
  assert.match(response.body.error.message, /cursor/i);
});

test('tools/list returns the three tools in order with schemas and annotations', async () => {
  const { rpc } = await shared;
  const { tools } = assertResult(await rpc('tools/list'));
  assert.deepEqual(tools.map((t) => t.name), ['search_findings', 'get_finding', 'list_cases']);
  for (const tool of tools) {
    assert.equal(typeof tool.title, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, 'object');
    assert.ok(Array.isArray(tool.outputSchema.required));
    assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false });
  }
  assert.deepEqual(tools[0].inputSchema.required, ['query']);
  assert.deepEqual(tools[0].inputSchema.properties.types.items.enum, ['domain', 'ip', 'email', 'handle', 'alias', 'wallet', 'unknown']);
  assert.deepEqual(tools[1].inputSchema.required, ['id']);
  assert.equal(tools[2].inputSchema.properties, undefined);
});

test('tools/call without Mcp-Name → 400 -32020', async () => {
  const { rpc } = await shared;
  const response = await rpc('tools/call', { name: 'list_cases', arguments: {} }, { omitHeaders: ['Mcp-Name'] });
  assertError(response, 400, -32020);
  assert.match(response.body.error.message, /Mcp-Name/);
});

test('tools/call with an Mcp-Name that differs from params.name → 400 -32020', async () => {
  const { rpc } = await shared;
  assertError(await rpc('tools/call', { name: 'list_cases', arguments: {} }, { headers: { 'Mcp-Name': 'get_finding' } }), 400, -32020);
  assertError(await rpc('tools/call', { name: 'list_cases', arguments: {} }, { headers: { 'Mcp-Name': '=?base64?!!?=' } }), 400, -32020);
});

test('tools/call accepts a base64-encoded Mcp-Name', async () => {
  const { rpc } = await shared;
  const response = await rpc('tools/call', { name: 'search_findings', arguments: { query: 'x' } }, { headers: { 'Mcp-Name': '=?base64?c2VhcmNoX2ZpbmRpbmdz?=' } });
  const result = assertResult(response);
  assert.equal(result.isError, undefined);
});

test('tools/call with an unknown tool → 200 -32602', async () => {
  const { rpc } = await shared;
  const response = await rpc('tools/call', { name: 'delete_everything', arguments: {} });
  assertError(response, 200, -32602);
  assert.equal(response.body.error.message, 'Unknown tool: delete_everything');
});

test('tools/call without name, or with non-object arguments → 200 -32602', async () => {
  const { rpc } = await shared;
  assertError(await rpc('tools/call', { arguments: {} }), 200, -32602);
  assertError(await rpc('tools/call', { name: 'list_cases', arguments: [] }), 200, -32602);
  assertError(await rpc('tools/call', { name: 'list_cases', arguments: null }), 200, -32602);
  assertError(await rpc('tools/call', { name: 'list_cases', arguments: 'x' }), 200, -32602);
});

test('tools/call without arguments: fine for list_cases, an isError result for search_findings', async () => {
  const { rpc } = await shared;
  const cases = assertResult(await rpc('tools/call', { name: 'list_cases' }));
  assert.equal(cases.isError, undefined);
  assert.equal(cases.structuredContent.cases[0].caseId, 'C-101');
  const search = assertResult(await rpc('tools/call', { name: 'search_findings' }));
  assert.equal(search.isError, true);
  assert.equal(search.structuredContent, undefined);
  assert.match(search.content[0].text, /query is required/);
});

test('tools/call returns structuredContent and the same JSON as text', async () => {
  const { rpc } = await shared;
  const result = assertResult(await rpc('tools/call', { name: 'search_findings', arguments: { query: '198' } }));
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  assert.ok(result.content[0].text.startsWith('{"dataNotice":'));
  const [hit] = result.structuredContent.results;
  assert.deepEqual(hit.matchedIn, ['entity']);
  assert.equal('score' in hit, false);
  assert.equal('highlights' in hit, false);
});

test('a tool that throws → 500 -32603 without detail', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const { rpc } = await start({ store: { ...FAKE_STORE, listCases: () => { throw new Error('secret detail'); } } });
  const response = await rpc('tools/call', { name: 'list_cases', arguments: {} }, { id: 'boom' });
  assertError(response, 500, -32603, 'boom');
  assert.equal(response.body.error.message, 'Internal error');
  assert.doesNotMatch(response.text, /secret detail/);
  assert.equal(logged.mock.callCount(), 1);
});

/** Opens a listen stream and returns a reader of its SSE events (comment lines skipped; null at end of stream). */
async function openListen(url, id, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true }, _meta: ENVELOPE } }),
    signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
        if (data.length > 0) return JSON.parse(data.join('\n'));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  }
  return { res, nextEvent };
}

async function waitFor(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), 'condition not reached within 1 s');
}

function assertAcknowledged(event, id) {
  assert.deepEqual(event, {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: { _meta: { [META.subscriptionId]: id }, notifications: {} },
  });
}

function assertCompleted(event, id) {
  assert.deepEqual(event, {
    jsonrpc: '2.0',
    id,
    result: { resultType: 'complete', _meta: { [META.subscriptionId]: id, [META.serverInfo]: SERVER_INFO } },
  });
}

for (const id of ['listen-1', 42]) {
  test(`subscriptions/listen acknowledges first with subscriptionId ${JSON.stringify(id)}; aborting closes it server-side`, async () => {
    const { url, handler } = await start();
    const abort = new AbortController();
    const { res, nextEvent } = await openListen(url, id, abort.signal);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assertAcknowledged(await nextEvent(), id);
    assert.equal(handler.openStreamCount(), 1);
    abort.abort();
    await waitFor(() => handler.openStreamCount() === 0);
  });
}

test('handler.close() answers the listen request and ends the stream', async () => {
  const { url, handler } = await start();
  const { nextEvent } = await openListen(url, 'shutdown');
  assertAcknowledged(await nextEvent(), 'shutdown');
  handler.close();
  assertCompleted(await nextEvent(), 'shutdown');
  assert.equal(await nextEvent(), null);
  assert.equal(handler.openStreamCount(), 0);
});

test('the 17th listen stream is acknowledged, completed and ended at once', async () => {
  const { url, handler } = await start();
  const abort = new AbortController();
  const open = [];
  for (let i = 0; i < 16; i++) {
    const stream = await openListen(url, i, abort.signal);
    assertAcknowledged(await stream.nextEvent(), i);
    open.push(stream);
  }
  assert.equal(handler.openStreamCount(), 16);
  const extra = await openListen(url, 'extra');
  assertAcknowledged(await extra.nextEvent(), 'extra');
  assertCompleted(await extra.nextEvent(), 'extra');
  assert.equal(await extra.nextEvent(), null);
  assert.equal(handler.openStreamCount(), 16);
  abort.abort();
  await waitFor(() => handler.openStreamCount() === 0);
});

test('tool calls are rate-limited per address in a fixed window', async () => {
  let clock = 1_000_000;
  const { rpc } = await start({ config: { mcpRateLimitPerMinute: 2 }, now: () => clock });
  const call = async () => assertResult(await rpc('tools/call', { name: 'list_cases', arguments: {} }));
  assert.equal((await call()).isError, undefined);
  assert.equal((await call()).isError, undefined);
  // Other methods are not counted.
  assertResult(await rpc('tools/list'));
  const limited = await call();
  assert.equal(limited.isError, true);
  assert.deepEqual(limited.content, [{ type: 'text', text: 'Rate limit exceeded. Retry in 60 seconds.' }]);
  clock += 30_000;
  assert.equal((await call()).content[0].text, 'Rate limit exceeded. Retry in 30 seconds.');
  clock += 30_000;
  assert.equal((await call()).isError, undefined);
});

test('a rate limit of 0 disables limiting', async () => {
  const { rpc } = await start({ config: { mcpRateLimitPerMinute: 0 }, now: () => 0 });
  for (let i = 0; i < 5; i++) {
    assert.equal(assertResult(await rpc('tools/call', { name: 'list_cases', arguments: {} })).isError, undefined);
  }
});
