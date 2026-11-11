import { fileURLToPath } from 'node:url';
import { sendJson } from './respond.js';
import { createStatic } from './static.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const SECURITY_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];

// `uri-host [":" port]`, IPv6 in brackets. Parsed by hand because `new URL` would read `evil.example@localhost`
// as localhost and rewrite `127.1` as 127.0.0.1; the allowlist must be compared with what was actually sent.
const HOST_HEADER = /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/;

/**
 * @param {string | undefined} headerValue  the Host header
 * @param {string[]} allowedHosts  lower-case hostnames, IPv6 in brackets
 */
export function isAllowedHost(headerValue, allowedHosts) {
  const match = typeof headerValue === 'string' ? HOST_HEADER.exec(headerValue) : null;
  return match !== null && allowedHosts.includes(match[1].toLowerCase());
}

/**
 * @param {string | undefined} headerValue  the Origin header
 * @param {string[]} allowedHosts
 */
export function isAllowedOrigin(headerValue, allowedHosts) {
  // Opaque origins (sandboxed frames, file: pages) arrive as the string `null`, which `new URL` rejects.
  try {
    return allowedHosts.includes(new URL(headerValue).hostname);
  } catch {
    return false;
  }
}

/**
 * Host and Origin are checked on every route. With no authentication, this is what stops a page on another
 * site from reading the API, and DNS rebinding from reaching `/mcp` (docs/DESIGN.md section 8).
 * @returns {string | null} why the request is refused, or null
 */
function refusal(headers, allowedHosts) {
  if (!isAllowedHost(headers.host, allowedHosts)) return 'Host not allowed';
  if (headers.origin !== undefined && !isAllowedOrigin(headers.origin, allowedHosts)) return 'Origin not allowed';
  return null;
}

function parseTarget(target) {
  try {
    return new URL(target, 'http://x');
  } catch {
    return null; // Node accepts targets such as `http://[` that the URL parser does not
  }
}

/**
 * @param {{
 *   store: object,
 *   config: { allowedHosts: string[] },
 *   mcpHandler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown,
 *   publicDir?: string,
 * }} deps  `publicDir` defaults to the repository's public/; tests pass a directory of their own.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp({ store, config, mcpHandler, publicDir = DEFAULT_PUBLIC_DIR }) {
  const serveStatic = createStatic(publicDir);

  return async function app(req, res) {
    for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
    const url = parseTarget(req.url);
    // MCP clients expect a JSON-RPC body, so errors on /mcp take that form.
    const isMcp = url?.pathname === '/mcp';

    try {
      const reason = refusal(req.headers, config.allowedHosts);
      if (reason !== null) {
        const body = isMcp
          ? { jsonrpc: '2.0', error: { code: -32600, message: reason } }
          : { error: { code: 'forbidden', message: reason } };
        sendJson(res, 403, body);
        return;
      }
      if (url === null) {
        sendJson(res, 400, { error: { code: 'bad_request', message: 'Malformed request URL' } });
        return;
      }
      if (isMcp) {
        await mcpHandler(req, res);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { Allow: 'GET, HEAD' });
        return;
      }
      serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        const body = isMcp
          ? { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }
          : { error: { code: 'internal', message: 'Internal error' } };
        sendJson(res, 500, body);
      } else if (!res.writableEnded) {
        // Too late for a status code; dropping the connection is the only way left to signal a broken response.
        res.destroy();
      }
    }
  };
}
