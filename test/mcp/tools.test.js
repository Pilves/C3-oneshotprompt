import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS, callTool } from '../../src/mcp/tools.js';

const DATA_FILE = fileURLToPath(new URL('../../findings.json', import.meta.url));
const RECORDS = JSON.parse(readFileSync(DATA_FILE, 'utf8')).findings;

// The store is built in a parallel work package. Skip only when the module is absent, so a broken store still fails.
const storeModule = await import('../../src/core/store.js').catch((err) => {
  if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw err;
});
const store = storeModule ? storeModule.loadStore(DATA_FILE) : null;
const withStore = { skip: store === null && 'src/core/store.js is not present on this branch' };

/** A store that fails the test if argument validation lets a call through. */
const UNREACHABLE_STORE = new Proxy({}, {
  get(_, key) {
    throw new Error(`store.${String(key)} must not be reached`);
  },
});

const toolNamed = (name) => TOOLS.find((tool) => tool.name === name);
const record = (id) => RECORDS.find((r) => r.id === id);

function assertToolError(result, pattern) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, pattern);
}

/** Hand-rolled check of the `required` lists in an outputSchema, at the top level and one level down. */
function assertConforms(structured, schema) {
  for (const key of schema.required) assert.ok(Object.hasOwn(structured, key), `missing ${key}`);
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = structured[key];
    if (value === undefined) continue;
    const items = property.type === 'array' ? value : [value];
    const required = property.type === 'array' ? property.items?.required : property.required;
    for (const item of items) {
      for (const field of required ?? []) assert.ok(Object.hasOwn(item, field), `${key}: missing ${field}`);
    }
  }
}

function assertSuccess(name, result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  assertConforms(result.structuredContent, toolNamed(name).outputSchema);
  return result.structuredContent;
}

test('unknown tool name → null', () => {
  assert.equal(callTool(UNREACHABLE_STORE, 'nope', {}), null);
});

test('search_findings rejects bad arguments before reaching the store', () => {
  assertToolError(callTool(UNREACHABLE_STORE, 'search_findings', {}), /query is required/);
  assertToolError(callTool(UNREACHABLE_STORE, 'search_findings', { query: '', types: ['banana'] }), /^Invalid arguments: types: /);
  assertToolError(callTool(UNREACHABLE_STORE, 'search_findings', { query: 'x', limit: 1000 }), /^Invalid arguments: limit: /);
  assertToolError(callTool(UNREACHABLE_STORE, 'search_findings', { query: 'x', bogus: 1 }), /^Invalid arguments: bogus: unknown parameter$/);
  assertToolError(callTool(UNREACHABLE_STORE, 'search_findings', { query: 5 }), /query: must be a string/);
  assertToolError(callTool(UNREACHABLE_STORE, 'search_findings', { query: 'x', limit: 0, offset: -1 }), /limit: .*; offset: /);
});

test('get_finding rejects bad arguments before reaching the store', () => {
  assertToolError(callTool(UNREACHABLE_STORE, 'get_finding', { id: 5 }), /^Invalid arguments: id: /);
  assertToolError(callTool(UNREACHABLE_STORE, 'get_finding', {}), /^Invalid arguments: id: /);
  assertToolError(callTool(UNREACHABLE_STORE, 'get_finding', { id: '  ' }), /^Invalid arguments: id: /);
  assertToolError(callTool(UNREACHABLE_STORE, 'get_finding', { id: 'F-10327', x: 1 }), /^Invalid arguments: x: unknown parameter$/);
});

test('list_cases takes no arguments', () => {
  assertToolError(callTool(UNREACHABLE_STORE, 'list_cases', { x: 1 }), /^Invalid arguments: x: unknown parameter$/);
});

test('search_findings returns ranked findings without score, highlights or raw', withStore, () => {
  const structured = assertSuccess('search_findings', callTool(store, 'search_findings', { query: 'phishing' }));
  assert.ok(structured.total > 0);
  assert.equal(structured.limit, 20);
  assert.equal(structured.offset, 0);
  assert.ok(structured.results.length > 0);
  for (const hit of structured.results) {
    assert.equal('score' in hit, false);
    assert.equal('highlights' in hit, false);
    assert.equal('raw' in hit, false);
    assert.ok(hit.matchedIn.length > 0);
    assert.ok(hit.matchedIn.every((field) => field === 'entity' || field === 'notes'));
  }
});

test('search_findings returns notes byte-identical to the file', withStore, () => {
  const structured = assertSuccess('search_findings', callTool(store, 'search_findings', { query: 'ignore' }));
  const hit = structured.results.find((r) => r.id === 'F-10209');
  assert.ok(hit, 'F-10209 is found');
  assert.equal(hit.notes, record('F-10209').notes);
  assert.ok(hit.flags.includes('notes_instruction_like'));
});

test('get_finding returns one finding including the original record', withStore, () => {
  const collision = assertSuccess('get_finding', callTool(store, 'get_finding', { id: 'F-10578-2' })).finding;
  assert.equal(collision.type, 'domain');
  assert.equal(collision.entity, 'sable-nimbus.test');

  const markup = assertSuccess('get_finding', callTool(store, 'get_finding', { id: 'F-10062' })).finding;
  assert.equal(markup.raw.notes, record('F-10062').notes);
  assert.equal(markup.raw.notes, "<script>alert('escape your output')</script>");
  assert.equal(markup.notes, record('F-10062').notes);
});

test('get_finding for an unknown id → isError naming the id', withStore, () => {
  assertToolError(callTool(store, 'get_finding', { id: 'nope' }), /^No finding with id "nope"\. Ids look like F-10327/);
});

test('list_cases returns 40 cases, one unassigned finding and a note', withStore, () => {
  const structured = assertSuccess('list_cases', callTool(store, 'list_cases', {}));
  assert.equal(structured.cases.length, 40);
  assert.equal(structured.cases[0].caseId, 'C-101');
  assert.equal(structured.unassigned.findingCount, 1);
  assert.equal(typeof structured.note, 'string');
});
