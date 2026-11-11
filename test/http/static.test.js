import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStatic } from '../../src/http/static.js';
import { listen, request, makePublicDir, PUBLIC_FILES, CSP } from './helpers.js';

const SERVED = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/highlight.js', 'highlight.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
];

let publicDir;
let server;
before(async () => {
  publicDir = makePublicDir();
  const serve = createStatic(publicDir.dir);
  // The raw request target goes in unchanged, so these tests control exactly which pathname the handler sees.
  server = await listen((req, res) => serve(req, res, req.url));
});
after(async () => {
  await server.close();
  publicDir.remove();
});

test('serves each allowlisted path with its content type and no-cache', async () => {
  for (const [path, file, type] of SERVED) {
    const res = await request(server.port, { path });
    assert.equal(res.status, 200, path);
    assert.equal(res.body, PUBLIC_FILES[file], path);
    assert.equal(res.headers['content-type'], type, path);
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(PUBLIC_FILES[file]), path);
    assert.equal(res.headers['cache-control'], 'no-cache', path);
  }
});

test('the HTML carries the CSP; nothing else does', async () => {
  for (const [path, file] of SERVED) {
    const res = await request(server.port, { path });
    if (file === 'index.html') assert.equal(res.headers['content-security-policy'], CSP, path);
    else assert.equal(res.headers['content-security-policy'], undefined, path);
  }
});

test('HEAD sends the headers and no body', async () => {
  for (const [path] of SERVED) {
    const get = await request(server.port, { path });
    const head = await request(server.port, { method: 'HEAD', path });
    assert.equal(head.status, 200, path);
    assert.equal(head.body, '', path);
    assert.equal(head.headers['content-length'], get.headers['content-length'], path);
    assert.equal(head.headers['content-type'], get.headers['content-type'], path);
  }
});

test('every other pathname is a JSON 404, traversal attempts included', async () => {
  for (const path of [
    '/index.htm',
    '/INDEX.HTML',
    '/index.html/',
    '//index.html',
    '/APP.JS',
    '/app.js/',
    '/./app.js',
    '/../package.json',
    '/app.js/../../src/server.js',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/public/index.html',
    '/package.json',
    '/findings.json',
    '/src/http/static.js',
    '/favicon.ico',
    '/__proto__',
    '/constructor',
  ]) {
    const res = await request(server.port, { path });
    assert.equal(res.status, 404, path);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', path);
    assert.deepEqual(JSON.parse(res.body), { error: { code: 'not_found', message: 'Not found' } }, path);
    assert.equal(res.headers['content-security-policy'], undefined, path);
  }
});

test('files are read once, when the handler is created', async () => {
  const dir = makePublicDir();
  const serve = createStatic(dir.dir);
  const own = await listen((req, res) => serve(req, res, req.url));
  try {
    writeFileSync(join(dir.dir, 'app.js'), 'changed on disk\n');
    dir.remove();
    const res = await request(own.port, { path: '/app.js' });
    assert.equal(res.status, 200);
    assert.equal(res.body, PUBLIC_FILES['app.js'], 'no filesystem access per request');
  } finally {
    await own.close();
    dir.remove();
  }
});

test('a missing file stops creation', () => {
  const { 'style.css': _omitted, ...rest } = PUBLIC_FILES;
  const dir = makePublicDir(rest);
  try {
    assert.throws(() => createStatic(dir.dir), /style\.css/);
  } finally {
    dir.remove();
  }
});
