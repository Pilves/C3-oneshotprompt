import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {net.AddressInfo} */ (probe.address());
  probe.close();
  await once(probe, 'close');
  return port;
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode} during start-up`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return res;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy within 10 s');
}

function mcp(base, method, params, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
  });
}

test('the server process serves UI, API and MCP from one dataset and stops on SIGTERM', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Blank values count as unset in config.js, so a developer's own environment cannot redirect the test.
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: '', ALLOWED_HOSTS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const health = await waitForHealth(base, child);
  assert.deepEqual(await health.json(), { status: 'ok', findings: 1032 });
  assert.match(output, /Loaded 1032 records \(0 skipped\): 1002 findings, 30 re-ingested duplicates, 40 cases/);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  await page.text();

  const api = await fetch(`${base}/api/findings?q=ongitsus&limit=100`);
  assert.equal(api.status, 200);
  const apiBody = await api.json();
  assert.ok(apiBody.total > 0);

  const call = await mcp(base, 'tools/call', { name: 'search_findings', arguments: { query: 'ongitsus', limit: 100 } }, { 'Mcp-Name': 'search_findings' });
  assert.equal(call.status, 200);
  const { result } = await call.json();
  assert.notEqual(result.isError, true);
  // One store behind both interfaces: same hits, same order.
  assert.equal(result.structuredContent.total, apiBody.total);
  assert.deepEqual(
    result.structuredContent.results.map((finding) => finding.id),
    apiBody.results.map((finding) => finding.id),
  );

  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('no exit within 2 s of SIGTERM')), 2000).unref());
  const [code, signal] = await Promise.race([exited, timeout]);
  assert.equal(signal, null);
  assert.equal(code, 0);
});
