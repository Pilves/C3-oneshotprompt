import http from 'node:http';

/**
 * Starts `handler` on an ephemeral loopback port.
 * @param {http.RequestListener} handler
 */
export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/**
 * One request on a fresh connection. node:http rather than fetch, because tests must be able to set `Host`
 * and to send paths such as `/../x` that fetch would normalise before sending.
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
export function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}
