import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { loadConfig } from '../../src/config.js';
import { createApp, isAllowedHost, isAllowedOrigin } from '../../src/http/app.js';
import { listen, request, makePublicDir, PUBLIC_FILES, CSP, SECURITY_HEADERS } from './helpers.js';

const DEFAULT_HOSTS = loadConfig({}).allowedHosts;
const JSON_TYPE = 'application/json; charset=utf-8';
const NOT_FOUND = { error: { code: 'not_found', message: 'Not found' } };

const mcpCalls = [];
async function mcpStub(req, res) {
  mcpCalls.push({ method: req.method, url: req.url });
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end('{"stub":true}');
}

let publicDir;
let server;
before(async () => {
  publicDir = makePublicDir();
  server = await listen(createApp({ store: {}, config: loadConfig({}), mcpHandler: mcpStub, publicDir: publicDir.dir }));
});
after(async () => {
  await server.close();
  publicDir.remove();
});

/** Starts a second app with different dependencies for the duration of `fn`. */
async function withApp(deps, fn) {
  const own = await listen(createApp({ config: loadConfig({}), mcpHandler: mcpStub, publicDir: publicDir.dir, store: {}, ...deps }));
  try {
    await fn(own.port);
  } finally {
    await own.close();
  }
}

const send = (options) => request(server.port, options);

function assertSecurityHeaders(res, label) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name], value, `${label}: ${name}`);
}

function assertJson(res, status, body, label) {
  assert.equal(res.status, status, label);
  assert.equal(res.headers['content-type'], JSON_TYPE, label);
  assert.deepEqual(JSON.parse(res.body), body, label);
}

/** HTTP/1.0 lets a request omit Host; node:http always sends one. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('isAllowedHost: allowed hostnames, with or without a port, in any letter case', () => {
  for (const host of ['localhost', 'localhost:3000', 'LOCALHOST:3000', 'LocalHost', 'localhost:', '127.0.0.1', '127.0.0.1:80', '[::1]', '[::1]:3000']) {
    assert.equal(isAllowedHost(host, DEFAULT_HOSTS), true, host);
  }
  assert.equal(isAllowedHost('findings.example:8080', ['findings.example']), true, 'uses the list it is given');
});

test('isAllowedHost: everything else', () => {
  for (const host of [
    undefined,
    '',
    ':3000',
    'evil.example',
    'evil.example:3000',
    'localhost.evil.example',
    'evil.localhost',
    'localhost.',
    '127.0.0.1.nip.io',
    '127.1',
    '2130706433',
    '0.0.0.0',
    '::1',
    '[::1',
    '::1]:3000',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]',
    'localhost:3000:3000',
    'localhost:abc',
    'localhost:3000/',
    'localhost/x',
    'evil.example@localhost',
    'localhost@evil.example',
    ' localhost',
    'localhost ',
    'localhost, evil.example',
  ]) {
    assert.equal(isAllowedHost(host, DEFAULT_HOSTS), false, JSON.stringify(host));
  }
  assert.equal(isAllowedHost(['localhost'], DEFAULT_HOSTS), false, 'non-string');
  assert.equal(isAllowedHost('localhost', ['findings.example']), false, 'no built-in list');
});

test('isAllowedOrigin: allowed hostnames on any port and scheme', () => {
  for (const origin of ['http://localhost:3000', 'http://localhost:5173', 'https://localhost', 'HTTP://LOCALHOST:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(isAllowedOrigin(origin, DEFAULT_HOSTS), true, origin);
  }
  assert.equal(isAllowedOrigin('https://findings.example', ['findings.example']), true, 'uses the list it is given');
});

test('isAllowedOrigin: null, unparseable and other hosts', () => {
  for (const origin of [
    undefined,
    '',
    'null',
    'localhost',
    'localhost:3000',
    'not a url',
    'http://',
    'file://',
    'about:blank',
    'http://evil.example',
    'https://evil.example:3000',
    'http://localhost.evil.example',
    'http://evil.localhost:3000',
    'http://localhost.:3000',
    'http://127.0.0.1.nip.io',
  ]) {
    assert.equal(isAllowedOrigin(origin, DEFAULT_HOSTS), false, JSON.stringify(origin));
  }
  assert.equal(isAllowedOrigin('http://localhost', ['findings.example']), false, 'no built-in list');
});

test('allowed Host headers are served', async () => {
  for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `LOCALHOST:${server.port}`, `[::1]:${server.port}`, 'localhost']) {
    const res = await send({ path: '/', headers: { Host: host } });
    assert.equal(res.status, 200, host);
  }
});

test('a Host that is not allowed gets 403 on every route and method', async () => {
  for (const path of ['/', '/index.html', '/app.js', '/api/findings', '/api/cases', '/healthz', '/nope']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const res = await send({ method, path, headers: { Host: 'evil.example' } });
      const label = `${method} ${path}`;
      assert.equal(res.status, 403, label);
      assertSecurityHeaders(res, label);
      if (method !== 'HEAD') assertJson(res, 403, { error: { code: 'forbidden', message: 'Host not allowed' } }, label);
    }
  }
  for (const host of [
    `evil.example:${server.port}`,
    'localhost.evil.example',
    `evil.localhost:${server.port}`,
    'evil.example@localhost',
    'localhost@evil.example',
    `127.0.0.1.nip.io:${server.port}`,
    `0.0.0.0:${server.port}`,
  ]) {
    const res = await send({ path: '/', headers: { Host: host } });
    assert.equal(res.status, 403, host);
  }
});

test('a request without a Host header gets 403', async () => {
  const response = await rawRequest(server.port, 'GET / HTTP/1.0\r\n\r\n');
  assert.match(response, /^HTTP\/1\.1 403 /);
  assert.match(response, /"Host not allowed"/);
});

test('an Origin that is not allowed gets 403', async () => {
  for (const path of ['/', '/api/findings', '/healthz']) {
    for (const origin of ['http://evil.example', 'null', 'http://localhost.evil.example', `http://evil.example:${server.port}`, '']) {
      const res = await send({ path, headers: { Origin: origin } });
      const label = `${path} Origin: ${JSON.stringify(origin)}`;
      assertJson(res, 403, { error: { code: 'forbidden', message: 'Origin not allowed' } }, label);
      assertSecurityHeaders(res, label);
    }
  }
});

test('an allowed Origin passes, whatever its port', async () => {
  for (const origin of ['http://localhost:5173', `http://127.0.0.1:${server.port}`, `http://[::1]:${server.port}`, 'https://localhost']) {
    const res = await send({ path: '/', headers: { Origin: origin } });
    assert.equal(res.status, 200, origin);
  }
});

test('/mcp: a Host or Origin that is not allowed gets a JSON-RPC 403 and never reaches the handler', async () => {
  const before = mcpCalls.length;
  for (const method of ['POST', 'GET']) {
    const host = await send({ method, path: '/mcp', headers: { Host: 'evil.example' } });
    assertJson(host, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'Host not allowed' } }, `${method} bad Host`);
    assertSecurityHeaders(host, `${method} bad Host`);

    for (const origin of ['http://evil.example', 'null']) {
      const res = await send({ method, path: '/mcp', headers: { Origin: origin } });
      assertJson(res, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } }, `${method} Origin ${origin}`);
    }
  }
  assert.equal(mcpCalls.length, before);
});

test('ALLOWED_HOSTS extends the allowlist', async () => {
  const config = loadConfig({ ALLOWED_HOSTS: 'Findings.Example, 10.0.0.5' });
  await withApp({ config }, async (port) => {
    for (const headers of [
      { Host: `findings.example:${port}` },
      { Host: '10.0.0.5' },
      { Host: `findings.example:${port}`, Origin: 'https://findings.example' },
      { Host: `localhost:${port}` },
    ]) {
      const res = await request(port, { path: '/', headers });
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
  });
  const res = await send({ path: '/', headers: { Host: 'findings.example' } });
  assert.equal(res.status, 403, 'not allowed without ALLOWED_HOSTS');
});

test('/mcp is delegated to the MCP handler, whatever the method', async () => {
  for (const method of ['POST', 'GET', 'DELETE', 'PUT', 'OPTIONS']) {
    const before = mcpCalls.length;
    const res = await send({ method, path: '/mcp' });
    assert.equal(res.status, 202, method);
    assert.equal(res.body, '{"stub":true}', method);
    assertSecurityHeaders(res, `${method} /mcp`);
    assert.deepEqual(mcpCalls.slice(before), [{ method, url: '/mcp' }]);
  }
  const before = mcpCalls.length;
  assert.equal((await send({ method: 'POST', path: '/mcp?x=1' })).status, 202, 'routed on the pathname');
  for (const path of ['/mcp/', '/mcp/x', '/MCP', '/%6dcp']) {
    assertJson(await send({ path }), 404, NOT_FOUND, path);
    assert.equal((await send({ method: 'POST', path })).status, 405, `POST ${path}`);
  }
  assert.deepEqual(mcpCalls.slice(before), [{ method: 'POST', url: '/mcp?x=1' }]);
});

test('methods other than GET and HEAD get 405 with Allow', async () => {
  for (const [method, path] of [
    ['POST', '/api/findings'],
    ['PUT', '/'],
    ['DELETE', '/api/cases'],
    ['PATCH', '/healthz'],
    ['OPTIONS', '/api/findings'],
    ['OPTIONS', '*'],
    ['POST', '/nope'],
  ]) {
    const res = await send({ method, path });
    const label = `${method} ${path}`;
    assertJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } }, label);
    assert.equal(res.headers.allow, 'GET, HEAD', label);
    assert.equal(res.headers['access-control-allow-origin'], undefined, label);
    assertSecurityHeaders(res, label);
  }
});

test('the UI files are served, with the CSP on the HTML only', async () => {
  for (const [path, file] of [
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/app.js', 'app.js'],
    ['/highlight.js', 'highlight.js'],
    ['/style.css', 'style.css'],
    ['/app.js?v=1', 'app.js'],
    ['/./app.js', 'app.js'],
  ]) {
    const res = await send({ path });
    assert.equal(res.status, 200, path);
    assert.equal(res.body, PUBLIC_FILES[file], path);
    assert.equal(res.headers['content-security-policy'], file === 'index.html' ? CSP : undefined, path);
    assertSecurityHeaders(res, path);
  }
});

test('HEAD gets the headers of GET and no body', async () => {
  for (const path of ['/', '/style.css', '/nope']) {
    const get = await send({ path });
    const head = await send({ method: 'HEAD', path });
    assert.equal(head.status, get.status, path);
    assert.equal(head.body, '', path);
    assert.equal(head.headers['content-length'], get.headers['content-length'], path);
    assert.equal(head.headers['content-type'], get.headers['content-type'], path);
  }
});

test('unknown paths get a JSON 404', async () => {
  for (const path of ['/nope', '/package.json', '/findings.json', '/src/server.js', '/public/index.html', '/api', '/healthz/', '/index.html/']) {
    const res = await send({ path });
    assertJson(res, 404, NOT_FOUND, path);
    assert.equal(res.headers['content-security-policy'], undefined, path);
    assertSecurityHeaders(res, path);
  }
});

test('path traversal never leaves the allowlist', async () => {
  for (const path of [
    '/../package.json',
    '/app.js/../../src/server.js',
    '/%2e%2e/package.json',
    '/%2E%2E/findings.json',
    '/.%2e/findings.json',
    '/..%2fpackage.json',
    '/%2e%2e%2fpackage.json',
    '/\\..\\package.json',
    '/%5c..%5cpackage.json',
    '/..;/package.json',
    '/index.html%00',
    '/../../../../etc/passwd',
    '//etc/passwd',
  ]) {
    assertJson(await send({ path }), 404, NOT_FOUND, path);
  }
});

test('a request target the URL parser rejects gets 400', async () => {
  const res = await send({ path: 'http://[' });
  assertJson(res, 400, { error: { code: 'bad_request', message: 'Malformed request URL' } }, 'http://[');
  assertSecurityHeaders(res, 'http://[');
});

test('an exception in the MCP handler becomes a generic JSON-RPC 500 and is logged', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const handlers = [
    () => {
      throw new Error('secret detail sync');
    },
    async () => {
      throw new Error('secret detail async');
    },
  ];
  for (const mcpHandler of handlers) {
    await withApp({ mcpHandler }, async (port) => {
      const res = await request(port, { method: 'POST', path: '/mcp' });
      assertJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }, mcpHandler.toString());
      assertSecurityHeaders(res, '500');
      assert.doesNotMatch(res.body, /secret/);
    });
  }
  assert.deepEqual(
    logged.mock.calls.map((call) => call.arguments[0].message),
    ['secret detail sync', 'secret detail async'],
  );
});

// The timeout turns a regression (a response that never ends) into a failure instead of a hang.
test('an exception after the headers were sent drops the connection', { timeout: 5000 }, async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const mcpHandler = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: partial\n\n');
    throw new Error('mid-stream failure');
  };
  await withApp({ mcpHandler }, async (port) => {
    await assert.rejects(request(port, { method: 'POST', path: '/mcp' }));
    assert.equal(logged.mock.callCount(), 1);
    assert.equal((await request(port, { path: '/' })).status, 200, 'the server keeps serving');
  });
});
