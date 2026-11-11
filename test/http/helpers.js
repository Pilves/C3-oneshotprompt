import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PUBLIC_FILES = {
  'index.html': '<!doctype html><title>Findings</title><script type="module" src="/app.js"></script>\n',
  'app.js': "import './highlight.js';\n",
  'highlight.js': '// Šokolaadimees: multi-byte, so Content-Length must count bytes\nexport {};\n',
  'style.css': 'body { color: #111; }\n',
};

/**
 * Writes the four UI files to a temporary directory. They are not kept under test/: `node --test` runs every
 * .js file below test/ as a test file.
 */
export function makePublicDir(files = PUBLIC_FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'findings-public-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

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
