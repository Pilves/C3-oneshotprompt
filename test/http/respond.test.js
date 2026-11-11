import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendJson } from '../../src/http/respond.js';
import { listen, request } from './helpers.js';

const BODY = { text: 'õngitsus <script>alert(1)</script>', n: 1, list: [null, true] };

let server;
before(async () => {
  server = await listen((req, res) => {
    if (req.url === '/extra') sendJson(res, 405, { error: 'x' }, { Allow: 'GET, HEAD' });
    else sendJson(res, 201, BODY);
  });
});
after(() => server.close());

test('sends status, JSON content type, no-store and the byte length', async () => {
  const res = await request(server.port);
  assert.equal(res.status, 201);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body, JSON.stringify(BODY), 'serialised as is, no HTML escaping');
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body), 'bytes, not characters');
  assert.notEqual(Buffer.byteLength(res.body), res.body.length, 'the body has multi-byte characters');
});

test('HEAD gets the same headers and no body', async () => {
  const get = await request(server.port);
  const head = await request(server.port, { method: 'HEAD' });
  assert.equal(head.status, 201);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.headers['content-type'], get.headers['content-type']);
});

test('adds extra headers', async () => {
  const res = await request(server.port, { path: '/extra' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(res.body), { error: 'x' });
});
