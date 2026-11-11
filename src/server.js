import http from 'node:http';
import { loadConfig } from './config.js';
import { loadStore } from './core/store.js';
import { createApp } from './http/app.js';
import { createMcpHandler } from './mcp/handler.js';

let config;
let store;
let mcpHandler;
let app;
try {
  config = loadConfig();
  store = loadStore(config.dataFile);
  mcpHandler = createMcpHandler({ store, config });
  app = createApp({ store, config, mcpHandler });
} catch (err) {
  console.error(`Start-up failed: ${err.message}`);
  process.exit(1);
}

const { records, skipped, canonical, duplicates, cases, declaredCount, countMismatch, flags } = store.stats;
const flagCounts = Object.entries(flags).map(([flag, count]) => `${flag}=${count}`).join(' ');
console.log(
  `Loaded ${records} records (${skipped} skipped): ${canonical} findings, ${duplicates} re-ingested duplicates, ${cases} cases. Flags: ${flagCounts}`,
);
if (countMismatch) console.warn(`Warning: _meta.count says ${declaredCount} records, the file has ${records}`);

const server = http.createServer(app);
server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  const { address, port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`Listening on ${address}:${port}`);
});
