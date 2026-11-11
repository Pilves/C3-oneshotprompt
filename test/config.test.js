import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

test('defaults', () => {
  const config = loadConfig({});
  assert.deepEqual(config, {
    port: 3000,
    host: '127.0.0.1',
    dataFile: fileURLToPath(new URL('../findings.json', import.meta.url)),
    allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
    mcpRateLimitPerMinute: 120,
  });
  assert.ok(existsSync(config.dataFile), 'default data file points at the repository copy');
});

test('blank values fall back to the defaults', () => {
  const config = loadConfig({ PORT: '', HOST: ' ', DATA_FILE: '', ALLOWED_HOSTS: '', MCP_RATE_LIMIT_PER_MIN: '' });
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.mcpRateLimitPerMinute, 120);
  assert.deepEqual(config.allowedHosts, ['localhost', '127.0.0.1', '[::1]']);
});

test('overrides', () => {
  const config = loadConfig({
    PORT: '8080',
    HOST: '0.0.0.0',
    DATA_FILE: '/data/other.json',
    ALLOWED_HOSTS: ' Findings.Example , ,10.0.0.5,localhost',
    MCP_RATE_LIMIT_PER_MIN: '0',
  });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.dataFile, '/data/other.json');
  assert.deepEqual(config.allowedHosts, ['localhost', '127.0.0.1', '[::1]', 'findings.example', '10.0.0.5']);
  assert.equal(config.mcpRateLimitPerMinute, 0, '0 disables the rate limit');
});

test('invalid numbers throw with the variable name', () => {
  for (const port of ['abc', '-1', '65536', '1e3', '3000.5', '0x10']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/, `PORT=${port}`);
  }
  for (const limit of ['-5', 'many', '1.5']) {
    assert.throws(() => loadConfig({ MCP_RATE_LIMIT_PER_MIN: limit }), /MCP_RATE_LIMIT_PER_MIN/, `limit=${limit}`);
  }
});

test('reads process.env by default', () => {
  const saved = process.env.PORT;
  process.env.PORT = '4321';
  try {
    assert.equal(loadConfig().port, 4321);
  } finally {
    if (saved === undefined) delete process.env.PORT;
    else process.env.PORT = saved;
  }
});
