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

const FAKE_STORE = {};

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
