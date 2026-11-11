import { parseSearchParams } from '../core/params.js';
import { sendJson } from './respond.js';

// HTTP query parameter → parseSearchParams key. Only these are read, so other query parameters never reach the
// validator and are ignored.
const SEARCH_PARAMS = new Map([
  ['q', 'query'],
  ['type', 'types'],
  ['case', 'caseId'],
  ['from', 'from'],
  ['to', 'to'],
  ['limit', 'limit'],
  ['offset', 'offset'],
  ['includeDuplicates', 'includeDuplicates'],
]);
const HTTP_NAMES = new Map([...SEARCH_PARAMS].map(([httpName, key]) => [key, httpName]));

const FINDING_PATH = /^\/api\/findings\/([^/]+)$/;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ search: Function, getFinding: Function, listCases: Function }} store
 */
export function handleApi(req, res, url, store) {
  if (url.pathname === '/api/findings') {
    searchFindings(res, url.searchParams, store);
    return;
  }
  const findingPath = FINDING_PATH.exec(url.pathname);
  if (findingPath) {
    getFinding(res, findingPath[1], store);
    return;
  }
  if (url.pathname === '/api/cases') {
    sendJson(res, 200, store.listCases());
    return;
  }
  sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
}

function searchFindings(res, searchParams, store) {
  const input = {};
  for (const [httpName, key] of SEARCH_PARAMS) {
    const values = searchParams.getAll(httpName);
    if (values.length === 0) continue;
    // A repeated `type` is how a form sends a multi-select; for the others the first value wins.
    input[key] = httpName === 'type' ? values.join(',') : values[0];
  }
  const parsed = parseSearchParams(input);
  if (!parsed.ok) {
    const details = parsed.errors.map(({ param, message }) => ({ param: HTTP_NAMES.get(param) ?? param, message }));
    sendJson(res, 400, { error: { code: 'invalid_params', message: 'Invalid query parameters', details } });
    return;
  }
  sendJson(res, 200, store.search(parsed.value));
}

function getFinding(res, segment, store) {
  let id;
  try {
    id = decodeURIComponent(segment);
  } catch {
    sendJson(res, 400, {
      error: { code: 'invalid_params', message: 'Invalid finding id', details: [{ param: 'id', message: 'malformed percent-encoding' }] },
    });
    return;
  }
  const finding = store.getFinding(id);
  if (!finding) {
    sendJson(res, 404, { error: { code: 'not_found', message: `No finding with id ${id}` } });
    return;
  }
  sendJson(res, 200, finding);
}
