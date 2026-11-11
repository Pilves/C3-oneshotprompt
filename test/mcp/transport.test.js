import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { rpcError, rpcResult, decodeHeaderValue, SERVER_INFO, META } from '../../src/mcp/protocol.js';
import { createMcpHandler } from '../../src/mcp/handler.js';

test('rpcError omits id when the request id is unknown', () => {
  assert.deepEqual(rpcError(undefined, -32700, 'Parse error'), { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
  assert.equal('id' in rpcError(undefined, -32600, 'x'), false);
});

test('rpcError keeps id and data when given', () => {
  assert.deepEqual(rpcError(7, -32022, 'Unsupported protocol version', { supported: ['2026-07-28'], requested: 'x' }), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: 'x' } },
  });
  assert.equal(rpcError('a', -32601, 'Method not found').id, 'a');
});

test('rpcResult adds resultType and serverInfo, merging an existing _meta', () => {
  assert.deepEqual(rpcResult(1, { tools: [] }), {
    jsonrpc: '2.0',
    id: 1,
    result: { resultType: 'complete', tools: [], _meta: { [META.serverInfo]: SERVER_INFO } },
  });
  const merged = rpcResult('s', { _meta: { [META.subscriptionId]: 's' } });
  assert.deepEqual(merged.result._meta, { [META.subscriptionId]: 's', [META.serverInfo]: SERVER_INFO });
});

test('SERVER_INFO carries the package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(SERVER_INFO, { name: 'findings-search', title: 'Findings search', version: pkg.version });
});

test('decodeHeaderValue decodes the base64 sentinel and passes other values through', () => {
  assert.equal(decodeHeaderValue('search_findings'), 'search_findings');
  assert.equal(decodeHeaderValue('=?base64?c2VhcmNoX2ZpbmRpbmdz?='), 'search_findings');
  assert.equal(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?='), 'Hello, 世界');
  assert.equal(decodeHeaderValue('=?base64??='), '');
  // Markers are case-sensitive, so this is a plain value.
  assert.equal(decodeHeaderValue('=?BASE64?c2VhcmNoX2ZpbmRpbmdz?='), '=?BASE64?c2VhcmNoX2ZpbmRpbmdz?=');
});

test('decodeHeaderValue rejects a sentinel with invalid base64', () => {
  assert.equal(decodeHeaderValue('=?base64?c2VhcmNoX2ZpbmRpbmdz!!?='), null);
  assert.equal(decodeHeaderValue('=?base64?abc?='), null);
});

// ---------------------------------------------------------------------------
// Black-box transport rules over HTTP (plan 5.2). The store is never reached by these requests.

const FAKE_STORE = {};
const ENVELOPE = {
  [META.protocolVersion]: '2026-07-28',
  [META.clientCapabilities]: {},
  [META.clientInfo]: { name: 'transport-test', version: '0' },
};

let server;
let url;

before(async () => {
  server = http.createServer(createMcpHandler({ store: FAKE_STORE, config: { mcpRateLimitPerMinute: 0 } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

/**
 * Sends one request with a correct modern envelope and headers unless told otherwise.
 * `meta: null` sends params without `_meta`; `rawBody` replaces the whole body.
 */
async function rpc(method, params = {}, { id = 1, headers = {}, omitHeaders = [], meta = ENVELOPE, rawBody, httpMethod = 'POST' } = {}) {
  const requestHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(method === 'tools/call' && typeof params.name === 'string' && { 'Mcp-Name': params.name }),
    ...headers,
  };
  for (const name of omitHeaders) delete requestHeaders[name];
  const body = rawBody ?? JSON.stringify({ jsonrpc: '2.0', id, method, params: meta === null ? params : { ...params, _meta: meta } });
  const res = await fetch(url, { method: httpMethod, headers: requestHeaders, body: ['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(httpMethod) ? undefined : body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text === '' ? undefined : JSON.parse(text) };
}

function assertError(response, status, code, id) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.body.jsonrpc, '2.0');
  assert.equal(response.body.error.code, code, response.text);
  assert.equal(typeof response.body.error.message, 'string');
  if (id === undefined) assert.equal('id' in response.body, false, 'error must have no id');
  else assert.equal(response.body.id, id);
  assert.equal(response.headers.get('mcp-session-id'), null);
}

for (const httpMethod of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
  test(`${httpMethod} → 405 with Allow: POST`, async () => {
    const response = await rpc('tools/list', {}, { httpMethod });
    assertError(response, 405, -32600);
    assert.equal(response.headers.get('allow'), 'POST');
  });
}

test('wrong content type → 415', async () => {
  assertError(await rpc('tools/list', {}, { headers: { 'Content-Type': 'text/plain' } }), 415, -32600);
  assertError(await rpc('tools/list', {}, { omitHeaders: ['Content-Type'], rawBody: new Blob(['{}']) }), 415, -32600);
});

test('content type is matched case-insensitively and may carry parameters', async () => {
  const response = await rpc('foo/bar', {}, { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } });
  assertError(response, 404, -32601, 1);
});

test('2 MiB body → 413 without reading it', async () => {
  const response = await rpc('tools/list', {}, { rawBody: Buffer.alloc(2 * 1024 * 1024, 0x20) });
  assertError(response, 413, -32600);
});

test('chunked body over 1 MiB → 413', async () => {
  const response = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    for (let i = 0; i < 24; i++) req.write(Buffer.alloc(64 * 1024, 0x20));
    req.end();
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, -32600);
});

test('a body of exactly 1 MiB is accepted', async () => {
  const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'foo/bar', params: { _meta: ENVELOPE } });
  const response = await rpc('foo/bar', {}, { rawBody: json.padEnd(1024 * 1024, ' ') });
  assertError(response, 404, -32601, 1);
});

test('invalid JSON → 400 -32700', async () => {
  assertError(await rpc('tools/list', {}, { rawBody: '{not json' }), 400, -32700);
  assertError(await rpc('tools/list', {}, { rawBody: '' }), 400, -32700);
});

test('batch array → 400 -32600', async () => {
  const one = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } };
  assertError(await rpc('tools/list', {}, { rawBody: JSON.stringify([one]) }), 400, -32600);
});

test('a posted response, a non-object and a wrong jsonrpc version → 400 -32600', async () => {
  assertError(await rpc('tools/list', {}, { rawBody: '{"jsonrpc":"2.0","id":23,"result":{}}' }), 400, -32600);
  assertError(await rpc('tools/list', {}, { rawBody: '"tools/list"' }), 400, -32600);
  assertError(await rpc('tools/list', {}, { rawBody: 'null' }), 400, -32600);
  assertError(await rpc('tools/list', {}, { rawBody: '{"jsonrpc":"1.0","id":1,"method":"tools/list"}' }), 400, -32600);
  assertError(await rpc('tools/list', {}, { rawBody: '{"jsonrpc":"2.0","id":1,"method":7}' }), 400, -32600);
});

test('id null, a float or an object → 400 -32600 without id', async () => {
  for (const id of [null, 1.5, { a: 1 }, true]) {
    assertError(await rpc('tools/list', {}, { id }), 400, -32600);
  }
});

test('notification → 202 with an empty body and no content type', async () => {
  const response = await rpc('notifications/cancelled', {}, { rawBody: '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}' });
  assert.equal(response.status, 202);
  assert.equal(response.text, '');
  assert.equal(response.headers.get('content-type'), null);
});

test('missing MCP-Protocol-Version → 400 -32020', async () => {
  const response = await rpc('tools/list', {}, { omitHeaders: ['MCP-Protocol-Version'] });
  assertError(response, 400, -32020, 1);
  assert.match(response.body.error.message, /MCP-Protocol-Version/);
  assert.match(response.body.error.message, /2026-07-28/);
});

test('missing Mcp-Method → 400 -32020', async () => {
  const response = await rpc('tools/list', {}, { omitHeaders: ['Mcp-Method'] });
  assertError(response, 400, -32020, 1);
  assert.match(response.body.error.message, /Mcp-Method/);
});

test('Mcp-Method that differs from the body, including by letter case → 400 -32020', async () => {
  assertError(await rpc('tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } }), 400, -32020, 1);
  assertError(await rpc('tools/list', {}, { headers: { 'Mcp-Method': 'Tools/List' } }), 400, -32020, 1);
});

test('header 2025-11-25 without the envelope → 400 -32022', async () => {
  const response = await rpc('tools/list', {}, { meta: null, headers: { 'MCP-Protocol-Version': '2025-11-25' } });
  assertError(response, 400, -32022, 1);
  assert.deepEqual(response.body.error.data, { supported: ['2026-07-28'], requested: '2025-11-25' });
});

test('supported header without _meta → 400 -32602', async () => {
  const response = await rpc('tools/list', {}, { meta: null });
  assertError(response, 400, -32602, 1);
  assert.match(response.body.error.message, /io\.modelcontextprotocol\/protocolVersion/);
});

test('_meta without clientCapabilities, or with a non-object one → 400 -32602', async () => {
  const response = await rpc('tools/list', {}, { meta: { [META.protocolVersion]: '2026-07-28' } });
  assertError(response, 400, -32602, 1);
  assert.match(response.body.error.message, /io\.modelcontextprotocol\/clientCapabilities/);
  assertError(await rpc('tools/list', {}, { meta: { ...ENVELOPE, [META.clientCapabilities]: [] } }), 400, -32602, 1);
});

test('header and body versions differ → 400 -32020', async () => {
  const response = await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
  assertError(response, 400, -32020, 1);
});

test('both versions 1900-01-01 → 400 -32022 with supported and requested', async () => {
  const response = await rpc('tools/list', {}, {
    id: 'v',
    headers: { 'MCP-Protocol-Version': '1900-01-01' },
    meta: { ...ENVELOPE, [META.protocolVersion]: '1900-01-01' },
  });
  assertError(response, 400, -32022, 'v');
  assert.deepEqual(response.body.error.data, { supported: ['2026-07-28'], requested: '1900-01-01' });
});

for (const method of ['foo/bar', 'ping', 'prompts/list', 'resources/list']) {
  test(`${method} → 404 -32601`, async () => {
    assertError(await rpc(method, {}, { id: 'abc' }), 404, -32601, 'abc');
  });
}

const INITIALIZE = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } };

test('initialize without any modern header → 400 -32022 naming the supported versions', async () => {
  const response = await rpc('initialize', INITIALIZE, { meta: null, omitHeaders: ['MCP-Protocol-Version', 'Mcp-Method'] });
  assertError(response, 400, -32022, 1);
  assert.deepEqual(response.body.error.data.supported, ['2026-07-28']);
  assert.equal(response.body.error.data.requested, '2025-11-25');
});

test('initialize with full modern headers and envelope → 400 -32022', async () => {
  const response = await rpc('initialize', INITIALIZE);
  assertError(response, 400, -32022, 1);
  assert.deepEqual(response.body.error.data, { supported: ['2026-07-28'], requested: '2025-11-25' });
});

test('initialize without params.protocolVersion reports the header version, or "unknown"', async () => {
  const withHeader = await rpc('initialize', {}, { meta: null, headers: { 'MCP-Protocol-Version': '2025-06-18' }, omitHeaders: ['Mcp-Method'] });
  assert.equal(withHeader.body.error.data.requested, '2025-06-18');
  const bare = await rpc('initialize', {}, { meta: null, omitHeaders: ['MCP-Protocol-Version', 'Mcp-Method'] });
  assert.equal(bare.body.error.data.requested, 'unknown');
});
