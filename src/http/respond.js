/**
 * JSON responses for the HTTP API, the health check and HTTP-level errors. The MCP handler does not use this:
 * its content type, limits and error bodies follow the MCP transport rules instead.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    ...headers,
  });
  // HEAD gets the GET response's headers, Content-Length included, and no body.
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}
