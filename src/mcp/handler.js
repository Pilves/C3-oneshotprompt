import { ERR, META, SUPPORTED_VERSIONS, rpcError } from './protocol.js';

const MAX_BODY_BYTES = 1024 * 1024;
const JSON_MEDIA_TYPE = /^application\/json\s*(?:;|$)/i;
const TOO_LARGE = Symbol('too large');

/**
 * Streamable HTTP endpoint for revision 2026-07-28. Stateless: every request is validated and answered on its own.
 * Host and Origin are checked by the caller before this runs.
 * @param {{ store: object, config: { mcpRateLimitPerMinute: number } }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMcpHandler({ store, config }) {
  async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (err) {
      // Only reached for failures outside method dispatch, such as a client that aborts mid-body.
      if (res.headersSent) {
        res.destroy();
      } else if (!req.destroyed) {
        console.error('MCP request failed:', err);
        sendJson(res, 500, rpcError(undefined, ERR.INTERNAL, 'Internal error'));
      }
    }
  }

  async function handle(req, res) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, rpcError(undefined, ERR.INVALID_REQUEST, 'Method not allowed'), { Allow: 'POST' });
    }
    if (!JSON_MEDIA_TYPE.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, rpcError(undefined, ERR.INVALID_REQUEST, 'Unsupported Media Type: Content-Type must be application/json'));
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === TOO_LARGE) {
      // The rest of the body is never read, so the connection cannot be reused.
      return sendJson(res, 413, rpcError(undefined, ERR.INVALID_REQUEST, 'Request body larger than 1 MiB'), { Connection: 'close' });
    }
    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 400, rpcError(undefined, ERR.PARSE, 'Parse error'));
    }
    // Arrays (batches) and posted responses are not allowed in this revision.
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return sendJson(res, 400, rpcError(undefined, ERR.INVALID_REQUEST, 'Invalid Request: expected a single JSON-RPC request or notification'));
    }
    if (!Object.hasOwn(message, 'id')) {
      // No client notification is defined over HTTP in this revision; accept and ignore.
      res.writeHead(202);
      return res.end();
    }
    const { id } = message;
    if (typeof id !== 'string' && !Number.isInteger(id)) {
      return sendJson(res, 400, rpcError(undefined, ERR.INVALID_REQUEST, 'Invalid Request: id must be a string or an integer'));
    }

    const invalid = validateModernRequest(req, message, id);
    if (invalid) return sendJson(res, ...invalid);

    try {
      return sendJson(res, ...dispatch(message, id));
    } catch (err) {
      console.error(`MCP ${message.method} failed:`, err);
      return sendJson(res, 500, rpcError(id, ERR.INTERNAL, 'Internal error'));
    }
  }

  function dispatch(message, id) {
    switch (message.method) {
      default:
        return [404, rpcError(id, ERR.METHOD_NOT_FOUND, 'Method not found')];
    }
  }

  return handler;
}

/**
 * Header and `_meta` rules of `basic/transports/streamable-http` › Server Validation and `basic` › `_meta`.
 * @returns {[number, object] | null} status and error body, or null when the request is valid
 */
function validateModernRequest(req, message, id) {
  const headerVersion = req.headers['mcp-protocol-version'];
  const methodHeader = req.headers['mcp-method'];
  if (headerVersion === undefined) {
    return [400, rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header is required (supported: ${SUPPORTED_VERSIONS.join(', ')})`)];
  }
  if (methodHeader === undefined) {
    return [400, rpcError(id, ERR.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is required')];
  }
  if (methodHeader !== message.method) {
    return [400, rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Method header ${JSON.stringify(methodHeader)} does not match body method ${JSON.stringify(message.method)}`)];
  }
  const meta = metaOf(message);
  const bodyVersion = meta?.[META.protocolVersion];
  if (typeof bodyVersion !== 'string') {
    // An unknown header version is the more useful answer: the client learns what to retry with.
    if (!SUPPORTED_VERSIONS.includes(headerVersion)) return [400, unsupportedVersion(id, headerVersion)];
    return [400, rpcError(id, ERR.INVALID_PARAMS, `Invalid params: missing required _meta field ${META.protocolVersion}`)];
  }
  if (!isPlainObject(meta[META.clientCapabilities])) {
    return [400, rpcError(id, ERR.INVALID_PARAMS, `Invalid params: missing required _meta field ${META.clientCapabilities}`)];
  }
  if (headerVersion !== bodyVersion) {
    return [400, rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header ${JSON.stringify(headerVersion)} does not match body version ${JSON.stringify(bodyVersion)}`)];
  }
  if (!SUPPORTED_VERSIONS.includes(bodyVersion)) return [400, unsupportedVersion(id, bodyVersion)];
  return null;
}

function unsupportedVersion(id, requested) {
  return rpcError(id, ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
}

function metaOf(message) {
  const meta = isPlainObject(message.params) ? message.params._meta : undefined;
  return isPlainObject(meta) ? meta : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Resolves with the body, or TOO_LARGE as soon as the limit is passed (the rest is not buffered). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      resolve(TOO_LARGE);
      return;
    }
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        resolve(TOO_LARGE);
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => onError(new Error('request closed before its body was read'));
    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}
