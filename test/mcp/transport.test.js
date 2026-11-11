import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rpcError, rpcResult, decodeHeaderValue, SERVER_INFO, META } from '../../src/mcp/protocol.js';

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
