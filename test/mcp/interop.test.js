import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../../src/config.js';
import { loadStore } from '../../src/core/store.js';
import { createApp } from '../../src/http/app.js';
import { createMcpHandler } from '../../src/mcp/handler.js';

// A dev dependency: without `npm ci` the suite is skipped, not failed. Any other import error is a real failure.
const sdk = await import('@modelcontextprotocol/client').catch((err) => {
  if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes("'@modelcontextprotocol/client'")) return null;
  throw err;
});

const MODES = [
  { label: 'pinned to 2026-07-28', options: { versionNegotiation: { mode: { pin: '2026-07-28' } } }, negotiated: '2026-07-28', legacy: false },
  { label: 'in auto mode', options: { versionNegotiation: { mode: 'auto' } }, negotiated: '2026-07-28', legacy: false },
  // The client's default is still the 2025 initialize handshake; the server's stateless fallback answers it (DESIGN 6.3).
  { label: 'in its default (legacy) mode', options: {}, negotiated: '2025-11-25', legacy: true },
];

test('official MCP client @modelcontextprotocol/client', { skip: sdk === null && 'dev dependency not installed (run npm ci)' }, async (t) => {
  const config = loadConfig({});
  const store = loadStore(config.dataFile);
  const mcpHandler = createMcpHandler({ store, config });
  const server = http.createServer(createApp({ store, config, mcpHandler }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);

  for (const mode of MODES) {
    await t.test(`connects ${mode.label}, lists and calls every tool`, async () => {
      const methods = [];
      const tracingFetch = (input, init) => {
        if (typeof init?.body === 'string') methods.push(JSON.parse(init.body).method);
        return fetch(input, init);
      };
      const client = new sdk.Client({ name: 'interop-test', version: '0' }, mode.options);
      await client.connect(new sdk.StreamableHTTPClientTransport(url, { fetch: tracingFetch }));
      try {
        assert.equal(client.getServerVersion().name, 'findings-search');
        assert.equal(client.getNegotiatedProtocolVersion(), mode.negotiated);
        assert.equal(methods.includes('initialize'), mode.legacy);

        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ['search_findings', 'get_finding', 'list_cases']);

        // The client validates each structuredContent against the tool's outputSchema before returning it.
        const search = await client.callTool({ name: 'search_findings', arguments: { query: 'ongitsus' } });
        assert.notEqual(search.isError, true);
        assert.equal(typeof search.structuredContent.dataNotice, 'string');
        assert.ok(search.structuredContent.results.length > 0);

        const finding = await client.callTool({ name: 'get_finding', arguments: { id: 'F-10578-2' } });
        assert.notEqual(finding.isError, true);
        assert.equal(finding.structuredContent.finding.entity, 'sable-nimbus.test');

        const cases = await client.callTool({ name: 'list_cases', arguments: {} });
        assert.notEqual(cases.isError, true);
        assert.equal(cases.structuredContent.cases.length, 40);

        const bad = await client.callTool({ name: 'search_findings', arguments: { query: 'x', limit: 1000 } });
        assert.equal(bad.isError, true);
        assert.match(bad.content[0].text, /limit/);

        await assert.rejects(client.callTool({ name: 'nope', arguments: {} }), (err) => err.code === -32602);
      } finally {
        await client.close();
      }
    });
  }
});
