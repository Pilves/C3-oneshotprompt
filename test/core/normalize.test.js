import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectShape, normalizeType } from '../../src/core/normalize.js';

test('detectShape', () => {
  const cases = [
    ['0x502ed0bf2a35bc83220658a70a09f2d4b69fc2d0', 'wallet'],
    ['0xCC2B8AF0945E2FC46653EF6BADACC21AB79CB2A4', 'wallet'],
    ['0x502ed0bf2a35bc83220658a70a09f2d4b69fc2d', null], // 39 hex digits
    ['0x502ed0bf2a35bc83220658a70a09f2d4b69fc2dg', null],
    ['192.0.2.14', 'ip'],
    ['2001:db8::1', 'ip'],
    ['256.1.1.1', null],
    ['1.2.3', null],
    ['harbor.sable@raven-tundra.test', 'email'],
    ['HARBOR.SABLE@RAVEN-TUNDRA.TEST', 'email'],
    ['a@b', null],
    ['tundra-ember.test', 'domain'],
    ['Sub.Example.COM', 'domain'],
    ['localhost', null],
    ['-bad.test', null],
    ['a..test', null],
    ['example.123', null],
    [`${'a'.repeat(63)}.`.repeat(4) + 'test', null], // 260 characters
    ['zephyr_raven92', null],
    ['Šokolaadimees', null],
  ];
  for (const [entity, shape] of cases) assert.equal(detectShape(entity), shape, entity);
});

test('type: the seven non-canonical labels in the dataset', () => {
  const rows = [
    ['F-10917', ' email ', 'tundra.pixel@harbor-drift.test', 'email', false],
    ['F-10788', 'ipv4', 'tundra-ember.test', 'domain', true],
    ['F-10819', 'Domain', '192.0.2.14', 'ip', true],
    ['F-10142', 'url', 'zephyr.nimbus@salt-flat.test', 'email', true],
    ['F-10380', 'Handle', 'vortex.raven@nimbus-salt.test', 'email', true],
    ['F-10582', 'IP', 'zephyr_raven92', 'unknown', true],
    ['F-10276', 'ALIAS', 'cobalt_harbor31', 'alias', false],
  ];
  for (const [id, label, entity, type, mismatch] of rows) {
    assert.deepEqual(normalizeType(label, entity), { type, mismatch }, id);
  }
});

test('type: labels that agree with the value', () => {
  assert.deepEqual(normalizeType('ip', '198.51.100.7'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('ipv4', '198.51.100.7'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('IPv6', '2001:db8::1'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('ip', '2001:db8::1'), { type: 'ip', mismatch: false });
  assert.deepEqual(normalizeType('wallet', '0x502ed0bf2a35bc83220658a70a09f2d4b69fc2d0'), { type: 'wallet', mismatch: false });
  assert.deepEqual(normalizeType('handle', 'pixel_ember17'), { type: 'handle', mismatch: false });
});

test('type: a label without checkable syntax is trusted', () => {
  assert.deepEqual(normalizeType('wallet', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), { type: 'wallet', mismatch: false });
  assert.deepEqual(normalizeType('alias', 'Šokolaadimees'), { type: 'alias', mismatch: false });
});

test('type: a label that the value contradicts', () => {
  assert.deepEqual(normalizeType('domain', 'not a domain'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('email', 'pixel_ember17'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('handle', '198.51.100.7'), { type: 'ip', mismatch: true });
  assert.deepEqual(normalizeType('ipv4', '2001:db8::1'), { type: 'ip', mismatch: false }, 'ipv4/ipv6 are both just ip');
});

test('type: missing or unknown label', () => {
  assert.deepEqual(normalizeType('', 'zephyr_raven92'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('person', 'zephyr_raven92'), { type: 'unknown', mismatch: true });
  assert.deepEqual(normalizeType('', 'tundra-ember.test'), { type: 'domain', mismatch: true });
  assert.deepEqual(normalizeType('unknown', 'zephyr_raven92'), { type: 'unknown', mismatch: false }, 'the label already says unknown');
});

test('type: empty entity is unknown without a mismatch (entity_missing covers it)', () => {
  assert.deepEqual(normalizeType('ip', ''), { type: 'unknown', mismatch: false });
});
