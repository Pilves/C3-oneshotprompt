import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, foldText } from '../../src/core/fold.js';

function assertInvariant(result) {
  assert.equal(result.starts.length, result.text.length);
  assert.equal(result.ends.length, result.text.length);
}

/** The original substring that a match of folded units [a, b) maps to. */
function original(str, result, a, b) {
  return str.slice(result.starts[a], result.ends[b - 1]);
}

test('diacritics and case are removed', () => {
  assert.equal(foldText('Šokolaadimees'), 'sokolaadimees');
  assert.equal(foldText('ŠOKOLAADIMEES'), 'sokolaadimees');
  assert.equal(foldText('ÕÄÖÜŽ'), 'oaouz');
  assert.equal(foldText('õngitsuskampaanias'), 'ongitsuskampaanias');
});

test('lower-case ASCII is unchanged and maps one to one', () => {
  const str = 'harbor.sable@raven-tundra.test 198.51.100.2';
  const result = fold(str);
  assert.equal(result.text, str);
  assert.deepEqual(result.starts, [...str].map((_, i) => i));
  assert.deepEqual(result.ends, [...str].map((_, i) => i + 1));
});

test('offsets point back into the original string', () => {
  const result = fold('Öökull');
  assert.equal(result.text, 'ookull');
  assertInvariant(result);
  assert.equal(result.starts[0], 0);
  assert.equal(result.ends[5], 6);

  const notes = 'Kasutaja märgiti õngitsuskampaanias.';
  const folded = fold(notes);
  const at = folded.text.indexOf('ongitsus');
  assert.equal(original(notes, folded, at, at + 'ongitsus'.length), 'õngitsus');
});

test('a decomposed character folds to its base letter and a match covers the combining mark', () => {
  const str = 'Šokolaadimees';
  const result = fold(str);
  assert.equal(result.text, 'sokolaadimees');
  assertInvariant(result);
  assert.deepEqual([result.starts[0], result.ends[0]], [0, 2]);
  assert.equal(original(str, result, 0, 1), 'Š');
  assert.equal(original(str, result, 0, 3), 'Šok');
  assert.equal(original(str, result, 1, 3), 'ok');
});

test('a combining mark with nothing before it contributes nothing', () => {
  const result = fold('̌ab');
  assert.equal(result.text, 'ab');
  assertInvariant(result);
  assert.deepEqual(result.starts, [1, 2]);
});

test('characters that change length keep the invariant', () => {
  const str = 'aİ😀b';
  const result = fold(str);
  assertInvariant(result);
  assert.equal(result.text, 'ai😀b');
  // İ lower-cases to i + U+0307; the dot is dropped and the i maps to the one original unit.
  assert.equal(original(str, result, 1, 2), 'İ');
  // The astral code point is two units in both strings and maps as a whole.
  assert.equal(original(str, result, 2, 4), '😀');
  assert.equal(original(str, result, 4, 5), 'b');
});

test('empty string', () => {
  assert.deepEqual(fold(''), { text: '', starts: [], ends: [] });
  assert.equal(foldText(''), '');
});
