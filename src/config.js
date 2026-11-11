import { fileURLToPath } from 'node:url';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Unset and blank count as "not configured", so `PORT=` in a Compose file falls back to the default. */
function readString(env, name, fallback) {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function readInteger(env, name, fallback, min, max) {
  const value = readString(env, name, null);
  if (value === null) return fallback;
  // Number() alone would accept '1e3', '0x10' and '3000.0'.
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(env[name])}`);
  }
  return Number(value);
}

export function loadConfig(env = process.env) {
  const extraHosts = readString(env, 'ALLOWED_HOSTS', '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return {
    port: readInteger(env, 'PORT', 3000, 0, 65535),
    host: readString(env, 'HOST', '127.0.0.1'),
    dataFile: readString(env, 'DATA_FILE', fileURLToPath(new URL('../findings.json', import.meta.url))),
    allowedHosts: [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts])],
    mcpRateLimitPerMinute: readInteger(env, 'MCP_RATE_LIMIT_PER_MIN', 120, 0, Number.MAX_SAFE_INTEGER),
  };
}
