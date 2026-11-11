// Static checks on public/: the rules in docs/DESIGN.md section 7 that a unit test of the helpers cannot see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const publicDir = new URL('../../public/', import.meta.url);
const files = readdirSync(publicDir).sort();
const read = (name) => readFileSync(new URL(name, publicDir), 'utf8');

const SINK = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|setAttribute\(\s*['"](?:href|src|on)/;
const EXTERNAL_URL = /https?:\/\//i;

test('the sink pattern catches what it is meant to catch', () => {
  for (const sample of [
    'el.innerHTML = notes', 'el.outerHTML=x', "el.insertAdjacentHTML('beforeend', x)", 'document.write(x)', 'document.writeln(x)',
    'eval(x)', 'eval (x)', 'new Function("x")', "a.setAttribute('href', u)", 'img.setAttribute("src", u)', "b.setAttribute( 'onclick', f)",
  ]) assert.match(sample, SINK, sample);
  for (const sample of ['el.textContent = notes', "a.setAttribute('aria-label', x)", 'evaluate(x)', 'medieval(x)']) {
    assert.doesNotMatch(sample, SINK, sample);
  }
});

test('public/ holds exactly the files the server serves', () => {
  // src/http/static.js serves a fixed map (implementation plan 4.4); anything else here would 404.
  assert.deepEqual(files, ['app.js', 'highlight.js', 'index.html', 'style.css']);
});

test('no file uses an HTML-parsing or code-evaluating sink', () => {
  for (const name of files) assert.doesNotMatch(read(name), SINK, name);
});

test('no file contains a javascript: URL or loads anything from another origin', () => {
  for (const name of files) {
    const text = read(name);
    assert.doesNotMatch(text, /javascript:/i, name);
    assert.doesNotMatch(text, EXTERNAL_URL, name);
  }
});

test('index.html has no inline script, inline style or inline event handler', () => {
  const html = read('index.html');
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  assert.equal(scripts.length, 1);
  for (const tag of scripts) assert.match(tag, /\ssrc="\/[a-z]+\.js"/, tag);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  // Scheme-relative URLs are external too.
  assert.doesNotMatch(html, /\s(?:src|href)\s*=\s*["']?\/\//i);
});

test('the stylesheet imports nothing', () => {
  // Fonts or images would need url(); the CSP blocks them and the page uses the system font stack.
  assert.doesNotMatch(read('style.css'), /@import|url\(/i);
});

test('the browser scripts parse as ES modules', () => {
  // app.js touches the DOM at load, so Node cannot import it; a syntax check is the most it can do.
  for (const name of files.filter((f) => f.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(name, publicDir))], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});
