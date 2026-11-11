import { ERR, META, SUPPORTED_VERSIONS, rpcError, rpcResult, decodeHeaderValue } from './protocol.js';
import { INSTRUCTIONS, TOOLS, callTool } from './tools.js';

const MAX_BODY_BYTES = 1024 * 1024;
// The tool list is static and identical for every caller (`server/utilities/caching`).
const CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: 'public' };
const MAX_LISTEN_STREAMS = 16;
const KEEP_ALIVE_MS = 25_000;
const RATE_WINDOW_MS = 60_000;
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
const JSON_MEDIA_TYPE = /^application\/json\s*(?:;|$)/i;
const TOO_LARGE = Symbol('too large');

/**
 * Streamable HTTP endpoint for revision 2026-07-28. Stateless: every request is validated and answered on its own.
 * Host and Origin are checked by the caller before this runs.
 * @param {{ store: object, config: { mcpRateLimitPerMinute: number }, now?: () => number }} options  `now` is injectable for tests
 * @returns {((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>)
 *   & { close(): void, openStreamCount(): number }}  close() ends every open listen stream (for shutdown)
 */
export function createMcpHandler({ store, config, now = Date.now }) {
  const streams = new Set();
  const takeCall = createRateLimiter(config.mcpRateLimitPerMinute, now);

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
      const reply = dispatch(req, res, message, id);
      if (reply) sendJson(res, ...reply);
    } catch (err) {
      console.error(`MCP ${message.method} failed:`, err);
      return sendJson(res, 500, rpcError(id, ERR.INTERNAL, 'Internal error'));
    }
  }

  /** @returns {[number, object] | undefined} status and body, or undefined when the method wrote its own response */
  function dispatch(req, res, message, id) {
    switch (message.method) {
      case 'server/discover':
        return [200, rpcResult(id, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ...CACHE_HINTS })];
      case 'tools/list':
        // No cursor is ever issued, so any cursor is invalid (`server/utilities/pagination`).
        if (message.params.cursor !== undefined) return [200, rpcError(id, ERR.INVALID_PARAMS, 'Invalid cursor')];
        return [200, rpcResult(id, { tools: TOOLS, ...CACHE_HINTS })];
      case 'tools/call':
        return callToolRequest(req, message.params, id);
      case 'subscriptions/listen':
        return listen(res, id);
      default:
        return [404, rpcError(id, ERR.METHOD_NOT_FOUND, 'Method not found')];
    }
  }

  /** Order from plan 5.2: malformed params, then Mcp-Name, then unknown tool. */
  function callToolRequest(req, params, id) {
    const { name, arguments: args } = params;
    if (typeof name !== 'string') return [200, rpcError(id, ERR.INVALID_PARAMS, 'Invalid params: name must be a string')];
    if (args !== undefined && !isPlainObject(args)) {
      return [200, rpcError(id, ERR.INVALID_PARAMS, 'Invalid params: arguments must be an object')];
    }
    const nameHeader = req.headers['mcp-name'];
    if (nameHeader === undefined) {
      return [400, rpcError(id, ERR.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is required for tools/call')];
    }
    if (decodeHeaderValue(nameHeader) !== name) {
      return [400, rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Name header does not match params.name ${JSON.stringify(name)}`)];
    }
    if (!TOOL_NAMES.has(name)) return [200, rpcError(id, ERR.INVALID_PARAMS, `Unknown tool: ${name}`)];
    const retryAfter = takeCall(req.socket.remoteAddress);
    if (retryAfter !== null) {
      // No error code exists for this; a tool result is the one channel the model is sure to see.
      return [200, rpcResult(id, { content: [{ type: 'text', text: `Rate limit exceeded. Retry in ${retryAfter} seconds.` }], isError: true })];
    }
    return [200, rpcResult(id, callTool(store, name, args ?? {}))];
  }

  /**
   * `basic/patterns/subscriptions`. Nothing in this server ever changes, so no notification type is honoured:
   * the acknowledgement carries an empty filter and the stream only keeps the connection alive until either side closes it.
   */
  function listen(res, id) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    writeEvent(res, {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: { [META.subscriptionId]: id }, notifications: {} },
    });
    let timer;
    const stream = {
      // Graceful closure: answer the listen request itself, then end the stream.
      end() {
        clearInterval(timer);
        streams.delete(stream);
        if (res.writableEnded || res.destroyed) return;
        writeEvent(res, rpcResult(id, { _meta: { [META.subscriptionId]: id } }));
        res.end();
      },
    };
    // Over the cap the stream is closed gracefully at once, which tells the client it ended rather than failed.
    if (streams.size >= MAX_LISTEN_STREAMS) return stream.end();
    timer = setInterval(() => res.write(':\n\n'), KEEP_ALIVE_MS);
    timer.unref();
    streams.add(stream);
    // Closing the stream is the client's cancellation (`basic/patterns/cancellation`).
    res.on('close', () => {
      clearInterval(timer);
      streams.delete(stream);
    });
  }

  handler.close = () => {
    for (const stream of streams) stream.end();
  };
  handler.openStreamCount = () => streams.size;
  return handler;
}

/**
 * Header and `_meta` rules of `basic/transports/streamable-http` › Server Validation and `basic` › `_meta`.
 * @returns {[number, object] | null} status and error body, or null when the request is valid
 */
function validateModernRequest(req, message, id) {
  const headerVersion = req.headers['mcp-protocol-version'];
  const methodHeader = req.headers['mcp-method'];
  if (message.method === 'initialize') {
    // `basic/versioning` › Backward Compatibility: name the supported versions, since a legacy client
    // has no other way to find out. -32022 is also what a dual-era client recognises as "modern server".
    return [400, unsupportedVersion(id, String(message.params?.protocolVersion ?? headerVersion ?? 'unknown'))];
  }
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

/**
 * Fixed window per client address (`server/tools` › Security Considerations asks for a rate limit).
 * @returns {(key: string|undefined) => number|null}  null when the call is allowed, else seconds until the window resets
 */
function createRateLimiter(limitPerWindow, now) {
  const windows = new Map();
  return (key) => {
    if (limitPerWindow === 0) return null;
    const time = now();
    // Dropping every expired window here keeps the map as small as the set of recent callers.
    for (const [address, window] of windows) {
      if (time - window.start >= RATE_WINDOW_MS) windows.delete(address);
    }
    let window = windows.get(key);
    if (window === undefined) {
      window = { start: time, count: 0 };
      windows.set(key, window);
    }
    if (window.count >= limitPerWindow) return Math.ceil((window.start + RATE_WINDOW_MS - time) / 1000);
    window.count += 1;
    return null;
  };
}

function writeEvent(res, message) {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
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
