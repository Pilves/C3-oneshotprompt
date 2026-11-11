// All text from the API is untrusted. It reaches the page only through textContent, text nodes
// and property assignment; see docs/DESIGN.md section 7.
import { FINDING_TYPES, splitByRanges, safeHref, buildSearchQuery, parseHash, formatHash } from './highlight.js';

// The data says handle and alias; the task says username and pseudonym (DESIGN.md T2).
const TYPE_LABELS = { handle: 'handle (username)', alias: 'alias (pseudonym)' };

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

const SOURCE_REASONS = {
  unsafe: 'not linked: unsafe scheme',
  missing: 'no source recorded',
  invalid: 'not linked: not a valid URL',
};

// The +02:00/+03:00 offsets in the data are Estonian time, so this is the clock the collectors saw.
const TALLINN = new Intl.DateTimeFormat('et-EE', { timeZone: 'Europe/Tallinn', dateStyle: 'medium', timeStyle: 'medium' });

const byId = (id) => document.getElementById(id);
const ui = {
  form: byId('search-form'),
  q: byId('q'),
  typeFilter: byId('type-filter'),
  caseSelect: byId('case'),
  from: byId('from'),
  to: byId('to'),
  dups: byId('dups'),
  status: byId('status'),
  results: byId('results'),
  pager: byId('pager'),
  prev: byId('prev'),
  next: byId('next'),
  searchView: byId('search-view'),
  detailView: byId('detail-view'),
  detail: byId('detail'),
  back: byId('back'),
};

const typeInputs = new Map();
const typeCounts = new Map();

// The URL fragment is the state: every view is rendered from the parsed hash.
let route = parseHash(location.hash);
let lastSearch = parseHash('');
let pageSize = 20;
let inFlight = null;
let typingTimer = 0;
let typingEntry = false;

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
const muted = (text) => el('span', { className: 'muted' }, text);
const findingLink = (id) => el('a', { href: formatHash({ view: 'finding', id }) }, id);
const caseLink = (caseId) => el('a', { href: formatHash({ view: 'search', case: caseId }) }, caseId);

/**
 * Fetches JSON for the current view. Starting a request aborts the previous one, and a response
 * that is no longer the latest is dropped, so a slow answer can never overwrite a newer one.
 * @returns {Promise<{ status: number, body: any } | null>} null when superseded; status 0 when the server could not be reached
 */
async function fetchLatest(url) {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  let result;
  try {
    const res = await fetch(url, { signal: controller.signal });
    result = { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    result = { status: 0, body: null };
  }
  return controller === inFlight ? result : null;
}

function errorText({ status, body }) {
  if (status === 0) return 'Could not reach the server.';
  const error = body?.error;
  if (!error) return `Unexpected response from the server (HTTP ${status}).`;
  const details = Array.isArray(error.details) ? error.details.map((d) => `${d.param}: ${d.message}`) : [];
  return details.length > 0 ? `${error.message}: ${details.join('; ')}` : String(error.message);
}

async function runSearch(search) {
  const query = buildSearchQuery(search);
  const res = await fetchLatest(query ? `/api/findings?${query}` : '/api/findings');
  if (!res) return;
  if (res.status === 200 && res.body) renderResults(res.body);
  else showSearchError(errorText(res));
}

function showSearchError(message) {
  for (const count of typeCounts.values()) count.textContent = '';
  ui.status.className = 'error';
  ui.status.textContent = message;
  ui.results.replaceChildren();
  ui.pager.hidden = true;
}

function renderResults({ total, limit, offset, results, facets }) {
  pageSize = limit;
  // Facets ignore the type filter, so each count says what ticking that type would add.
  for (const [type, count] of typeCounts) count.textContent = `(${facets?.types?.[type] ?? 0})`;
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
  // Links to the detail view, never to the entity itself: it may be a live malicious domain.
  const entity = el('a', { href: formatHash({ view: 'finding', id: f.id }), className: 'entity' });
  if (f.entity) appendHighlighted(entity, f.entity, f.highlights?.entity);
  else entity.append('(no entity)');
  const notes = f.notes
    ? appendHighlighted(el('p', { className: 'notes' }), f.notes, f.highlights?.notes)
    : el('p', { className: 'notes muted' }, '(no notes)');
  const meta = el('div', { className: 'meta' },
    el('span', null, f.id),
    el('span', null, ...(f.caseIds.length > 0 ? joined(f.caseIds.map(caseLink)) : ['no case'])),
    el('span', null, f.observedAt ? timeEl(f.observedAt, false) : 'time unknown'));
  if (f.duplicates.length > 0) meta.append(el('span', null, `+${plural(f.duplicates.length, 'duplicate')}`));
  if (f.flags.length > 0) meta.append(el('span', { className: 'flags' }, ...f.flags.map(flagBadge)));
  return el('li', { className: 'result' },
    el('div', null, el('span', { className: 'badge' }, f.type), ' ', entity),
    notes,
    meta);
}

async function showFinding(id) {
  ui.detail.replaceChildren(muted('Loading…'));
  const res = await fetchLatest(`/api/findings/${encodeURIComponent(id)}`);
  if (!res) return;
  if (res.status === 200 && res.body) renderDetail(res.body);
  else ui.detail.replaceChildren(el('p', { className: 'error' }, res.status === 404 ? `No finding with id ${id}` : errorText(res)));
}

function renderDetail(f) {
  const heading = el('h2', { tabIndex: -1 }, `Finding ${f.id}`);
  const list = el('dl');
  const row = (term, ...content) => list.append(el('dt', null, term), el('dd', null, ...content));
  row('Id', f.id, f.rawId !== f.id ? ` (in the source: ${f.rawId})` : '');
  row('Type', typeText(f));
  row('Entity', f.entity ? el('span', { className: 'entity' }, f.entity) : muted('none'));
  row('Cases', ...(f.caseIds.length > 0 ? joined(f.caseIds.map(caseLink)) : [muted('none')]));
  row('Observed', ...(f.observedAt
    ? [timeEl(f.observedAt, true), el('br'), `${TALLINN.format(new Date(f.observedAt))} Europe/Tallinn`]
    : [muted('unknown')]));
  row('Notes', f.notes ? el('span', { className: 'notes' }, f.notes) : muted('none'));
  row('Source', ...sourceNodes(f.source));
  row('Flags', f.flags.length > 0
    ? el('ul', { className: 'flag-list' }, ...f.flags.map((flag) => el('li', null, flagBadge(flag), ' ', FLAG_TEXT[flag] ?? '')))
    : muted('none'));
  if (f.duplicateOf) row('Duplicate of', findingLink(f.duplicateOf));
  if (f.duplicates.length > 0) row('Duplicates', ...joined(f.duplicates.map((id) => findingLink(id))));
  if (f.sameRawId.length > 0) row('Same id in the source', ...joined(f.sameRawId.map((id) => findingLink(id))));
  // The same entity often turns up in several cases; this is the pivot to all of them.
  const pivot = f.entity
    ? el('p', null, el('a', { href: formatHash({ view: 'search', q: f.entity }) }, 'Find other findings for this entity'))
    : '';
  ui.detail.replaceChildren(
    heading,
    list,
    pivot,
    el('h3', null, 'Original record'),
    el('pre', { textContent: JSON.stringify(f.raw, null, 2) }),
  );
  heading.focus();
}

function typeText(f) {
  const label = TYPE_LABELS[f.type] ?? f.type;
  if (f.typeRaw === f.type) return label;
  if (f.typeRaw === '') return `${label}, no type label in the source`;
  // JSON quoting keeps a padded label such as " email " visible.
  return `${label}, labelled ${JSON.stringify(f.typeRaw)} in the source`;
}

function sourceNodes(source) {
  const href = safeHref(source);
  if (href) {
    const link = el('a', { href, rel: 'noopener noreferrer', target: '_blank', referrerPolicy: 'no-referrer' }, source.raw.trim());
    return source.status === 'scheme_assumed' ? [link, ' (scheme assumed)'] : [link];
  }
  const reason = SOURCE_REASONS[source?.status] ?? 'not linked';
  return source?.raw ? [el('code', null, source.raw), ' ', muted(`(${reason})`)] : [muted(reason)];
}

function render(next) {
  route = next;
  const searching = route.view === 'search';
  ui.searchView.hidden = !searching;
  ui.detailView.hidden = searching;
  if (searching) {
    lastSearch = route;
    document.title = 'Findings search';
    syncForm(route);
    runSearch(route);
  } else {
    document.title = `${route.id} · Findings search`;
    ui.back.href = formatHash(lastSearch);
    showFinding(route.id);
  }
}

function formRoute() {
  return {
    view: 'search',
    q: ui.q.value.trim(),
    types: FINDING_TYPES.filter((type) => typeInputs.get(type).checked),
    case: ui.caseSelect.value,
    from: ui.from.value,
    to: ui.to.value,
    dups: ui.dups.checked,
    offset: 0,
  };
}

function syncForm(search) {
  // Comparing trimmed values leaves the box alone while someone types a trailing space.
  if (ui.q.value.trim() !== search.q) ui.q.value = search.q;
  for (const [type, input] of typeInputs) input.checked = search.types.includes(type);
  selectCase(search.case);
  ui.from.value = search.from;
  ui.to.value = search.to;
  ui.dups.checked = search.dups;
}

function selectCase(caseId) {
  // A case from the URL may arrive before the case list, or not be in it at all.
  if (![...ui.caseSelect.options].some((option) => option.value === caseId)) {
    ui.caseSelect.append(el('option', { value: caseId }, caseId));
  }
  ui.caseSelect.value = caseId;
}

/** Navigates by pushing a history entry; the hashchange handler renders. */
function go(next) {
  clearTimeout(typingTimer);
  typingEntry = false;
  const hash = formatHash(next);
  if (hash !== location.hash) location.hash = hash;
}

/** @returns {boolean} whether the search changed */
function commitTyping() {
  clearTimeout(typingTimer);
  const next = formRoute();
  const hash = formatHash(next);
  if (hash === location.hash) return false;
  // The first update of a burst of typing adds a history entry and later ones replace it, so Back
  // returns to the previous search instead of stepping through keystrokes. Neither fires hashchange.
  history[typingEntry ? 'replaceState' : 'pushState'](null, '', hash);
  typingEntry = true;
  render(next);
  return true;
}

async function loadCases() {
  try {
    const res = await fetch('/api/cases');
    if (!res.ok) return;
    const { cases } = await res.json();
    const fixed = [...ui.caseSelect.options].slice(0, 2); // "any" and "unassigned" from index.html
    ui.caseSelect.replaceChildren(...fixed, ...cases.map((c) => el('option', { value: c.caseId }, c.caseId)));
    selectCase(lastSearch.case);
  } catch {
    // The filter still offers "any" and "unassigned"; the search itself reports server problems.
  }
}

for (const type of FINDING_TYPES) {
  const input = el('input', { type: 'checkbox', value: type });
  const count = el('span', { className: 'count' });
  typeInputs.set(type, input);
  typeCounts.set(type, count);
  ui.typeFilter.append(el('label', null, input, ` ${TYPE_LABELS[type] ?? type} `, count));
}

ui.q.addEventListener('input', () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(commitTyping, 250);
});
// The text box also fires change on blur; typing is handled above.
ui.form.addEventListener('change', (event) => {
  if (event.target !== ui.q) go(formRoute());
});
ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  // Unchanged: search again, which is how to retry after a network error.
  if (!commitTyping()) runSearch(route);
  typingEntry = false;
});
ui.prev.addEventListener('click', () => {
  go({ ...route, offset: Math.max(0, route.offset - pageSize) });
  window.scrollTo(0, 0);
});
ui.next.addEventListener('click', () => {
  go({ ...route, offset: route.offset + pageSize });
  window.scrollTo(0, 0);
});
window.addEventListener('hashchange', () => {
  clearTimeout(typingTimer);
  typingEntry = false;
  render(parseHash(location.hash));
});

render(route);
loadCases();
