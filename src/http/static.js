import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from './respond.js';

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';

// Every file that can ever be served. The request pathname is only a key into this list; it never becomes
// part of a filesystem path, so there is nothing to traverse.
const ROUTES = [
  ['/', 'index.html', HTML],
  ['/index.html', 'index.html', HTML],
  ['/app.js', 'app.js', JS],
  ['/highlight.js', 'highlight.js', JS],
  ['/style.css', 'style.css', CSS],
];

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Reads the files once, so a missing file stops start-up rather than breaking the page later.
 * @param {string} publicDir
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => void}
 */
export function createStatic(publicDir) {
  const files = new Map(
    ROUTES.map(([pathname, file, type]) => {
      const body = readFileSync(join(publicDir, file));
      const headers = { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' };
      if (type === HTML) headers['Content-Security-Policy'] = CSP;
      return [pathname, { body, headers }];
    }),
  );

  return (req, res, pathname) => {
    const file = files.get(pathname);
    if (!file) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    res.writeHead(200, file.headers);
    res.end(req.method === 'HEAD' ? undefined : file.body);
  };
}
