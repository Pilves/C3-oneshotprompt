import { readFileSync } from 'node:fs';

export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
/** Initialize-based revisions served by the stateless fallback, newest first. All three use Streamable HTTP. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
};

// -32000…-32019, -32002 and -32042 are never emitted: `basic` › Error Codes reserves or retires them.
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
};

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const SERVER_INFO = { name: 'findings-search', title: 'Findings search', version };

/** An error whose request id could not be read carries no `id` key: the 2026-07-28 schema forbids `null` ids. */
export function rpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    ...(id !== undefined && { id }),
    error: { code, message, ...(data !== undefined && { data }) },
  };
}

export function rpcResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result: { resultType: 'complete', ...result, _meta: { ...result._meta, [META.serverInfo]: SERVER_INFO } },
  };
}

/** Legacy revisions define no `resultType` and no per-result serverInfo, so their results are sent as they are. */
export function rpcLegacyResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/s;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes the `=?base64?…?=` form that `Mcp-Name` uses for values that are not plain ASCII
 * (`basic/transports/streamable-http` › Value Encoding). Other values are returned unchanged.
 * A sentinel with invalid Base64 returns null, so it can never equal a body value.
 * @param {string} value
 * @returns {string|null}
 */
export function decodeHeaderValue(value) {
  const match = BASE64_SENTINEL.exec(value);
  if (!match) return value;
  // Buffer.from silently skips invalid characters, which could turn garbage into a matching name.
  if (!BASE64.test(match[1])) return null;
  return Buffer.from(match[1], 'base64').toString('utf8');
}
