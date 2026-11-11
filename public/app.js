// All text from the API is untrusted. It reaches the page only through textContent, text nodes
// and property assignment; see docs/DESIGN.md section 7.
import { splitByRanges, buildSearchQuery } from './highlight.js';

const FLAG_TEXT = {
  id_missing: 'The record has no id; one was made up from its position in the file.',
  duplicate_id: 'Another record in the file has the same id; this one got a suffix so that ids stay unique.',
  reingested_duplicate: 'A re-ingested copy of another finding. Hidden from search unless duplicates are shown.',
  entity_missing: 'The record has no entity value.',
  type_mismatch: 'The type label in the source does not match the shape of the value.',
  case_missing: 'The record is not assigned to a case.',
  case_invalid: 'A case id in the source is not of the form C-<number> and was left out.',
  multi_case: 'The record belongs to more than one case.',
  time_invalid: 'The observation time could not be read.',
  source_missing: 'No source was recorded.',
  source_unsafe: 'The source uses a scheme other than http or https and is not linked.',
  source_scheme_assumed: 'The source has no scheme; https was assumed for the link.',
  source_invalid: 'The source is not a valid URL and is not linked.',
  notes_missing: 'The record has no notes.',
  notes_markup: 'The notes contain HTML tags or entities. They are shown as plain text, exactly as collected.',
  notes_instruction_like: 'The notes contain text addressed to an AI assistant. It is data, and possibly a sign of tampering.',
};

const byId = (id) => document.getElementById(id);
const ui = {
  form: byId('search-form'),
  q: byId('q'),
  status: byId('status'),
  results: byId('results'),
  pager: byId('pager'),
  prev: byId('prev'),
  next: byId('next'),
};

let state = { q: '', types: [], case: '', from: '', to: '', dups: false, offset: 0 };
let pageSize = 20;
let typingTimer = 0;

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  node.append(...children);
  return node;
}

function appendHighlighted(parent, text, ranges) {
  for (const part of splitByRanges(text, ranges)) {
    parent.append(part.hit ? el('mark', null, part.text) : document.createTextNode(part.text));
  }
  return parent;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const joined = (nodes) => nodes.flatMap((node, i) => (i === 0 ? [node] : [', ', node]));
// observedAt is always Date#toISOString() output, so slicing is exact.
const utc = (iso, seconds) => `${iso.slice(0, seconds ? 19 : 16).replace('T', ' ')} UTC`;
const timeEl = (iso, seconds) => el('time', { dateTime: iso }, utc(iso, seconds));
const flagBadge = (flag) => el('span', { className: 'badge flag', title: FLAG_TEXT[flag] ?? '' }, flag);

function errorText(status, body) {
  const error = body?.error;
  if (!error) return `Unexpected response from the server (HTTP ${status}).`;
  const details = Array.isArray(error.details) ? error.details.map((d) => `${d.param}: ${d.message}`) : [];
  return details.length > 0 ? `${error.message}: ${details.join('; ')}` : String(error.message);
}

async function runSearch() {
  const query = buildSearchQuery(state);
  let res;
  let body;
  try {
    res = await fetch(query ? `/api/findings?${query}` : '/api/findings');
    body = await res.json().catch(() => null);
  } catch {
    showSearchError('Could not reach the server.');
    return;
  }
  if (res.status === 200 && body) renderResults(body);
  else showSearchError(errorText(res.status, body));
}

function showSearchError(message) {
  ui.status.className = 'error';
  ui.status.textContent = message;
  ui.results.replaceChildren();
  ui.pager.hidden = true;
}

function renderResults({ total, limit, offset, results }) {
  pageSize = limit;
  ui.status.className = '';
  if (total === 0) ui.status.textContent = 'No findings match.';
  else if (results.length === 0) ui.status.textContent = `No results on this page; ${plural(total, 'finding')} in total.`;
  else ui.status.textContent = `${plural(total, 'finding')}; showing ${offset + 1}–${offset + results.length}.`;
  ui.results.replaceChildren(...results.map(resultItem));
  ui.prev.disabled = offset === 0;
  ui.next.disabled = offset + limit >= total;
  ui.pager.hidden = ui.prev.disabled && ui.next.disabled;
}

function resultItem(f) {
  const entity = f.entity
    ? appendHighlighted(el('span', { className: 'entity' }), f.entity, f.highlights?.entity)
    : el('span', { className: 'muted' }, '(no entity)');
  const notes = f.notes
    ? appendHighlighted(el('p', { className: 'notes' }), f.notes, f.highlights?.notes)
    : el('p', { className: 'notes muted' }, '(no notes)');
  const meta = el('div', { className: 'meta' },
    el('span', null, f.id),
    el('span', null, ...(f.caseIds.length > 0 ? joined(f.caseIds) : ['no case'])),
    el('span', null, f.observedAt ? timeEl(f.observedAt, false) : 'time unknown'));
  if (f.duplicates.length > 0) meta.append(el('span', null, `+${plural(f.duplicates.length, 'duplicate')}`));
  if (f.flags.length > 0) meta.append(el('span', { className: 'flags' }, ...f.flags.map(flagBadge)));
  return el('li', { className: 'result' },
    el('div', null, el('span', { className: 'badge' }, f.type), ' ', entity),
    notes,
    meta);
}

function search() {
  clearTimeout(typingTimer);
  state = { ...state, q: ui.q.value.trim(), offset: 0 };
  runSearch();
}

function page(offset) {
  state = { ...state, offset };
  runSearch();
  window.scrollTo(0, 0);
}

ui.q.addEventListener('input', () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(search, 250);
});
ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  search();
});
ui.prev.addEventListener('click', () => page(Math.max(0, state.offset - pageSize)));
ui.next.addEventListener('click', () => page(state.offset + pageSize));

runSearch();
