import * as http from 'http';
import * as https from 'https';
import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import {
  PreparedChatRequest,
  ReasoningBridge,
  ResponseContext,
  ensureStreamUsageOptions,
  estimateUsage,
  formatUsageSseFrame,
} from './reasoningBridge';

export interface ProxyConfig {
  port: number;
  maxRetries: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  upstreams: Record<string, string>;
  sniffTimeoutMs: number;  // First frame sniff timeout in milliseconds
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogCallback = (level: LogLevel, message: string) => void;

function shouldRetry(statusCode: number, bodyText: string): boolean {
  if ([429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }
  if (bodyText && statusCode >= 400) {
    const lower = bodyText.toLowerCase();
    if (
      lower.includes('rate limit') ||
      lower.includes('rate_limit') ||
      lower.includes('11210') ||
      lower.includes('chatratelimited') ||
      lower.includes('too many requests') ||
      lower.includes('quota') ||
      lower.includes('authorization failed')
    ) {
      return true;
    }
  }
  return false;
}

function isNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('connection') ||
    msg.includes('hmac signature cannot be verified') ||
    msg.includes('apikey not found')
  );
}

function getBackoffDelay(retryCount: number, config: ProxyConfig): number {
  const base = Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, retryCount),
    config.maxBackoffMs
  );
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reasoningScopeSalt = randomBytes(32);

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return Array.isArray(value) ? value.join(',') : value || '';
    }
  }
  return '';
}

function isSignedRequest(
  headers: Record<string, string | string[] | undefined>
): boolean {
  const authorization = headerValue(headers, 'authorization');
  
  // Detect HMAC/signature-based auth schemes (these become invalid when request body changes)
  // Note: Bearer tokens and API Keys are just identity verification and won't be invalidated by body modification
  if (/^(aws4-hmac|hmac|signature|digest)\b/i.test(authorization)) {
    return true;
  }
  
  // Common signature-related header detection
  // Only includes headers that change with request body content, not pure authentication headers
  const signatureHeaders = new Set([
    // AWS signatures (change with request body)
    'content-md5',
    'content-digest',
    'digest',
    'x-amz-content-sha256',
    'x-amz-signature',
    'x-amz-credential',
    'x-amz-algorithm',
    'x-aws-signature',
    // Anthropic signatures (change with request body)
    'x-anthropic-signature',
    // Google Cloud signatures (change with request body)
    'x-goog-signature',
    // Generic signature headers (change with request body)
    'x-body-signature',
    'x-content-signature',
    'x-signature',
    'x-hmac-signature',
    'x-request-signature',
    'x-signature-version',
    // Third-party platform HMAC signatures
    'x-slack-signature',
    'x-shopify-hmac-sha256',
    'x-verify',
  ]);
  
  // Check for signature-related headers
  const headerKeys = Object.keys(headers);
  for (const key of headerKeys) {
    const lowerKey = key.toLowerCase();
    // Direct match
    if (signatureHeaders.has(lowerKey)) {
      return true;
    }
    // Prefix match (e.g. x-shopify-)
    if (lowerKey.startsWith('x-shopify-') || lowerKey.startsWith('x-slack-')) {
      return true;
    }
  }
  
  // Additional detection: Authorization header contains signature-based auth schemes
  if (authorization) {
    const authLower = authorization.toLowerCase();
    // Only detect signature schemes that change with request body
    const signatureKeywords = [
      'aws4-',           // AWS Signature V4
      'aws4-hmac',       // AWS Signature V4
      'hmac-sha',        // HMAC variant
      'signature=',      // Signature parameter
      'signed=',         // Signed request
      'oauth ',          // OAuth 1.0 signature (note the space to avoid matching oauth2)
      'oauth1',          // OAuth 1.0
    ];
    for (const keyword of signatureKeywords) {
      if (authLower.includes(keyword)) {
        return true;
      }
    }
  }
  
  return false;
}

function isChatCompletionsRequest(
  method: string | undefined,
  targetUrl: string,
  headers: Record<string, string | string[] | undefined>
): boolean {
  if ((method || 'GET').toUpperCase() !== 'POST') return false;
  try {
    const pathname = new URL(targetUrl).pathname.replace(/\/+$/, '');
    const contentType = headerValue(headers, 'content-type').toLowerCase();
    return (
      pathname.endsWith('/chat/completions') &&
      (!contentType || contentType.includes('application/json'))
    );
  } catch {
    return false;
  }
}

function reasoningScope(
  targetUrl: string,
  headers: Record<string, string | string[] | undefined>
): string {
  const url = new URL(targetUrl);
  const credential =
    headerValue(headers, 'authorization') ||
    headerValue(headers, 'x-api-key') ||
    headerValue(headers, 'api-key');
  return createHash('sha256')
    .update(reasoningScopeSalt)
    .update(`${url.protocol}//${url.host}${url.pathname}`)
    .update('\0')
    .update(credential)
    .digest('hex');
}

class AgentManager {
  private agents = new Map<string, http.Agent | https.Agent>();

  getAgent(isHttps: boolean, hostname: string, port?: number | string): http.Agent | https.Agent {
    const cacheKey = port ? `${hostname}:${port}` : `${hostname}:${isHttps ? '443' : '80'}`;

    let agent = this.agents.get(cacheKey);
    if (!agent) {
      const options = {
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 60000,
        freeSocketTimeout: 30000,
      };

      agent = isHttps ? new https.Agent(options) : new http.Agent(options);
      this.agents.set(cacheKey, agent);
    }

    return agent;
  }

  destroyAll() {
    for (const agent of this.agents.values()) {
      agent.destroy();
    }
    this.agents.clear();
  }
}

const agentManager = new AgentManager();

function filterSignatureHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const filtered = { ...headers };
  const signatureHeaders = [
    'x-request-id',
    'x-correlation-id', 
    'x-session-id',
    'x-timestamp',
    'x-date',
    'date',
    'x-amz-date',
    'x-azure-ref',
    'x-client-request-id',
    'x-client-session-id',
    'x-ms-client-request-id',
    'x-ms-correlation-request-id',
  ];
  
  for (const header of signatureHeaders) {
    for (const key of Object.keys(filtered)) {
      if (key.toLowerCase() === header) {
        delete filtered[key];
      }
    }
  }
  
  return filtered;
}

function makeRequest(
  targetUrl: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  bodyBuffer: Buffer
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const agent = agentManager.getAgent(isHttps, url.hostname, url.port);

    const reqHeaders: Record<string, string | string[] | undefined> = { ...headers };
    delete reqHeaders['host'];
    delete reqHeaders['content-length'];
    delete reqHeaders['transfer-encoding'];
    delete reqHeaders['connection'];
    delete reqHeaders['keep-alive'];
    delete reqHeaders['proxy-connection'];
    delete reqHeaders['expect'];
    if (bodyBuffer.length > 0) {
      reqHeaders['content-length'] = String(bodyBuffer.length);
    }

    const req = (isHttps ? https : http).request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: reqHeaders as http.OutgoingHttpHeaders,
        agent,
      },
      (res) => {
        resolve(res);
      }
    );

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('upstream timeout'));
    });

    if (bodyBuffer && bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function collectResponse(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/**
 * Lightweight SSE usage sniffer: scans each upstream chunk for data frames containing usage.
 * Only checks if the buffer contains `"usage":{"prompt_tokens"`, avoiding JSON.parse on every chunk.
 */
class StreamUsageDetector {
  private pending = '';
  private sawUsage = false;

  push(chunk: Buffer): void {
    if (this.sawUsage) return;
    const tail =
      this.pending.length > 1024 ? this.pending.slice(-1024) : this.pending;
    this.pending = tail + chunk.toString('utf8');
    if (
      this.pending.includes('"usage"') &&
      this.pending.includes('"prompt_tokens"')
    ) {
      this.sawUsage = true;
      this.pending = '';
    } else if (this.pending.length > 64 * 1024) {
      this.pending = this.pending.slice(-1024);
    }
  }

  hasUsage(): boolean {
    return this.sawUsage;
  }
}

function ensureJsonResponseUsage(
  body: Buffer,
  requestMessages: unknown,
  model?: string
): Buffer {
  if (body.length === 0 || body.length > 16 * 1024 * 1024) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object') return body;
  const record = parsed as Record<string, unknown>;
  if (!record.choices || !Array.isArray(record.choices)) return body;
  if (record.usage && typeof record.usage === 'object') return body;

  let assistantContent = '';
  const firstChoice = record.choices[0];
  if (firstChoice && typeof firstChoice === 'object') {
    const msg = (firstChoice as Record<string, unknown>).message;
    if (msg && typeof msg === 'object') {
      const c = (msg as Record<string, unknown>).content;
      assistantContent = typeof c === 'string' ? c : '';
    }
  }
  const usage = estimateUsage(
    Array.isArray(requestMessages)
      ? (requestMessages as import('./reasoningBridge').ChatMessage[])
      : undefined,
    assistantContent
  );
  if (model && typeof model === 'string') {
    record.model = model;
  }
  record.usage = usage;
  return Buffer.from(JSON.stringify(record), 'utf8');
}

function responseHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = { ...headers };
  delete result['transfer-encoding'];
  delete result['connection'];
  delete result['keep-alive'];
  delete result['proxy-connection'];
  delete result['upgrade'];
  return result;
}

function isStreamingResponse(res: http.IncomingMessage): boolean {
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  return (
    contentType.includes('text/event-stream') ||
    contentType.includes('application/x-ndjson') ||
    contentType.includes('application/json-seq')
  );
}

function isFirstFrameStreamError(firstChunk: Buffer): boolean {
  const text = firstChunk.toString('utf8').slice(0, 16 * 1024);
  if (!text) return false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      if (record.error) return true;
      if (record.type === 'error' && record.message) return true;
    } catch {
    }
  }
  return false;
}

function sniffFirstChunk(
  upstreamRes: http.IncomingMessage,
  timeoutMs: number = 10000
): Promise<{ kind: 'retry' | 'stream'; firstChunk: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | null = null;
    
    const onChunk = (chunk: Buffer) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      upstreamRes.pause();
      cleanup();
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (isFirstFrameStreamError(buf)) {
        resolve({ kind: 'retry', firstChunk: buf });
      } else {
        resolve({ kind: 'stream', firstChunk: buf });
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
      resolve({ kind: 'retry', firstChunk: Buffer.alloc(0) });
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`sniffFirstChunk timeout after ${timeoutMs}ms`));
    };
    
    const cleanup = () => {
      upstreamRes.removeListener('data', onChunk);
      upstreamRes.removeListener('end', onEnd);
      upstreamRes.removeListener('error', onError);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    
    if (timeoutMs > 0) {
      timeoutId = setTimeout(onTimeout, timeoutMs);
    }
    
    upstreamRes.once('data', onChunk);
    upstreamRes.once('end', onEnd);
    upstreamRes.once('error', onError);
  });
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const maskedHost =
      host.length > 8 ? host.slice(0, 4) + '***' + host.slice(-4) : '***';
    return `${parsed.protocol}//${maskedHost}${parsed.pathname}${parsed.search}`;
  } catch {
    return '***';
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ProxyConfig,
  log: LogCallback,
  reasoningBridge: ReasoningBridge
): Promise<void> {
  const reqUrl = new URL(req.url || '/', `http://localhost:${config.port}`);

  let matchedPrefix: string | null = null;
  let upstreamBase: string | null = null;
  for (const [prefix, base] of Object.entries(config.upstreams)) {
    if (reqUrl.pathname === prefix || reqUrl.pathname.startsWith(`${prefix}/`)) {
      matchedPrefix = prefix;
      upstreamBase = base;
      break;
    }
  }

  if (!matchedPrefix || !upstreamBase) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Unknown upstream prefix',
        available: Object.keys(config.upstreams),
        received: reqUrl.pathname,
      })
    );
    return;
  }

  const upstreamPath = reqUrl.pathname.slice(matchedPrefix.length);
  const targetUrl = upstreamBase + upstreamPath + reqUrl.search;

  const reqChunks: Buffer[] = [];
  for await (const chunk of req) {
    reqChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const reqBody = Buffer.concat(reqChunks);

  const rawHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  const reasoningEligible = isChatCompletionsRequest(
    req.method,
    targetUrl,
    rawHeaders
  );
  let requestForReasoning: Buffer = reqBody;
  let requestMessages: import('./reasoningBridge').ChatMessage[] | undefined;
  if (reasoningEligible) {
    const usageOptions = ensureStreamUsageOptions(reqBody);
    requestForReasoning = usageOptions.body;
    requestMessages = usageOptions.requestMessages;
    if (usageOptions.modified) {
      log(
        'info',
        '[usage] Injected stream_options.include_usage=true, upstream will send usage frame at stream end'
      );
    }
  }

  let preparedRequest: PreparedChatRequest = {
    body: requestForReasoning,
    injectedCount: 0,
    promotedAliasCount: 0,
    assistantCount: 0,
    missingReasoningCount: 0,
    unresolvedCount: 0,
    unresolvedToolCallCount: 0,
  };
  let responseContext: ResponseContext | undefined;
  if (reasoningEligible && !isSignedRequest(rawHeaders)) {
    const scope = reasoningScope(targetUrl, rawHeaders);
    preparedRequest = reasoningBridge.prepareRequest(requestForReasoning, scope);
    responseContext = {
      scope,
      model: preparedRequest.model,
      requestFingerprint: preparedRequest.requestFingerprint,
    };
    rawHeaders['accept-encoding'] = 'identity';
    if (preparedRequest.injectedCount > 0) {
      log(
        'info',
        `[reasoning] Backfilled reasoning_content for ${preparedRequest.injectedCount} assistant messages`
      );
    }
    if (
      preparedRequest.missingReasoningCount > 0 ||
      preparedRequest.promotedAliasCount > 0
    ) {
      log(
        preparedRequest.unresolvedCount > 0 ? 'warn' : 'info',
        `[reasoning] assistant=${preparedRequest.assistantCount}, ` +
          `missing=${preparedRequest.missingReasoningCount}, ` +
          `alias_restored=${preparedRequest.promotedAliasCount}, ` +
          `cache_backfilled=${preparedRequest.injectedCount}, ` +
          `still_missing=${preparedRequest.unresolvedCount}, ` +
          `tool_msg_missing=${preparedRequest.unresolvedToolCallCount}`
      );
    }
  } else if (reasoningEligible) {
    log('warn', '[reasoning] Request contains content signature, skipping reasoning_content injection');
  }
  const reqHeaders = rawHeaders;

  let lastError: Error | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt - 1, config);
        log('info', `[retry ${attempt}/${config.maxRetries}] Waiting ${delay}ms before retrying ${maskUrl(targetUrl)}`);
        await sleep(delay);
      }

      const currentHeaders = attempt > 0 ? filterSignatureHeaders(rawHeaders) : reqHeaders;

      log('info', `${req.method} ${maskUrl(targetUrl)} (attempt ${attempt + 1})`);

      const upstreamRes = await makeRequest(
        targetUrl,
        req.method || 'GET',
        currentHeaders,
        preparedRequest.body
      );
      const statusCode = upstreamRes.statusCode || 500;
      lastStatus = statusCode;

      if (shouldRetry(statusCode, '') || !isStreamingResponse(upstreamRes)) {
        const body = await collectResponse(upstreamRes);
        const bodyText = body.toString('utf8');
        if (shouldRetry(statusCode, bodyText) && attempt < config.maxRetries) {
          log('warn', `[retry] Triggered retry: status=${statusCode} body=${bodyText.slice(0, 200)}`);
          continue;
        }

        if (
          responseContext &&
          statusCode >= 200 &&
          statusCode < 300 &&
          reasoningBridge.captureJsonResponse(body, responseContext)
        ) {
          log('info', '[reasoning] Cached reasoning context from non-streaming response');
        }

        let outBody = body;
        if (
          reasoningEligible &&
          statusCode >= 200 &&
          statusCode < 300 &&
          bodyText.includes('"choices"')
        ) {
          const before = outBody.length;
          outBody = ensureJsonResponseUsage(
            outBody,
            requestMessages,
            preparedRequest.model
          );
          if (outBody.length !== before) {
            log('info', '[usage] Non-streaming response missing usage field, estimated value added');
          }
        }

        const outHeaders = responseHeaders(upstreamRes.headers);
        outHeaders['content-length'] = String(outBody.length);
        res.writeHead(statusCode, outHeaders);
        res.end(outBody);
        return;
      }

      let firstChunk: Buffer;
      try {
        const sniffed = await sniffFirstChunk(upstreamRes, config.sniffTimeoutMs);
        if (sniffed.kind === 'retry') {
          if (attempt < config.maxRetries) {
            log('warn', '[retry] Stream first frame carries structured error signal, preparing to retry');
            upstreamRes.destroy();
            continue;
          }
          res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
          res.end(sniffed.firstChunk);
          upstreamRes.destroy();
          return;
        }
        firstChunk = sniffed.firstChunk;
      } catch (err) {
        const errMsg = (err as Error).message;
        // Timeout error should not trigger retry as upstream may just be slow, continue forwarding data
        if (errMsg.includes('timeout')) {
          log('warn', `[stream] Sniff first frame timeout (${config.sniffTimeoutMs}ms), continuing to wait for first frame data`);
          // Don't destroy the connection, let it continue flowing
          upstreamRes.resume();
          // Wait for first frame data, at most another sniffTimeoutMs
          try {
            const firstData = await new Promise<Buffer>((resolve, reject) => {
              const timeout = setTimeout(() => {
                reject(new Error('wait first chunk timeout'));
              }, config.sniffTimeoutMs);
              
              const onChunk = (chunk: Buffer) => {
                clearTimeout(timeout);
                upstreamRes.removeListener('data', onChunk);
                upstreamRes.removeListener('end', onEnd);
                upstreamRes.removeListener('error', onError);
                resolve(chunk);
              };
              const onEnd = () => {
                clearTimeout(timeout);
                upstreamRes.removeListener('data', onChunk);
                upstreamRes.removeListener('end', onEnd);
                upstreamRes.removeListener('error', onError);
                resolve(Buffer.alloc(0));
              };
              const onError = (e: Error) => {
                clearTimeout(timeout);
                upstreamRes.removeListener('data', onChunk);
                upstreamRes.removeListener('end', onEnd);
                upstreamRes.removeListener('error', onError);
                reject(e);
              };
              
              upstreamRes.once('data', onChunk);
              upstreamRes.once('end', onEnd);
              upstreamRes.once('error', onError);
            });
            
            if (firstData.length > 0) {
              if (isFirstFrameStreamError(firstData) && attempt < config.maxRetries) {
                log('warn', '[retry] First frame received after wait carries error signal, preparing to retry');
                upstreamRes.destroy();
                continue;
              }
              firstChunk = firstData;
            } else {
              // Upstream ended prematurely
              log('warn', '[stream] Upstream ended while waiting for first frame');
              upstreamRes.destroy();
              return;
            }
          } catch (waitErr) {
            log('error', `[stream] Failed to wait for first frame data: ${(waitErr as Error).message}`);
            upstreamRes.destroy();
            return;
          }
        } else if (attempt < config.maxRetries && isNetworkError(err as Error)) {
          log('warn', `[retry] Sniff first frame network error, attempting retry: ${errMsg}`);
          upstreamRes.destroy();
          continue;
        }
        log('error', `[stream] Sniff first frame failed: ${(err as Error).message}`);
        if (attempt < config.maxRetries) {
          upstreamRes.destroy();
          continue;
        }
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sniff failed', message: (err as Error).message }));
        } else if (!res.destroyed) {
          res.destroy(err as Error);
        }
        return;
      }

      res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
      const reasoningObserver =
        responseContext && statusCode >= 200 && statusCode < 300
          ? reasoningBridge.observeStream(responseContext)
          : undefined;
      let reasoningCacheLogged = false;
      const observeReasoningChunk = (chunk: Buffer) => {
        if (reasoningObserver?.push(chunk) && !reasoningCacheLogged) {
          reasoningCacheLogged = true;
          log('info', '[reasoning] Cached reasoning context from streaming response');
        }
      };
      observeReasoningChunk(firstChunk);

      const usageDetector = new StreamUsageDetector();
      usageDetector.push(firstChunk);

      const idleTimeoutMs = 60000; // 60s idle timeout
      let idleTimer: NodeJS.Timeout | null = null;

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          log('warn', `[stream] Upstream no data for ${idleTimeoutMs}ms, triggering idle timeout disconnect`);
          upstreamRes.destroy(new Error('upstream idle timeout'));
        }, idleTimeoutMs);
      };

      resetIdleTimer();

      await new Promise<void>((resolve, reject) => {
        let done = false;
        let upstreamEnded = false;
        let waitingForDrain = false;

        const onDrain = () => {
          waitingForDrain = false;
          if (!done && !upstreamRes.destroyed) {
            upstreamRes.resume();
          }
        };

        const cleanup = () => {
          upstreamRes.removeListener('data', onData);
          upstreamRes.removeListener('end', onEnd);
          upstreamRes.removeListener('error', onUpstreamError);
          upstreamRes.removeListener('aborted', onUpstreamAborted);
          res.removeListener('drain', onDrain);
          res.removeListener('error', onDownstreamError);
          res.removeListener('close', onDownstreamClose);
        };

        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          cleanup();
          if (err) reject(err);
          else resolve();
        };

        const forwardChunk = (chunk: Buffer) => {
          resetIdleTimer();
          if (!res.write(chunk) && !waitingForDrain) {
            waitingForDrain = true;
            upstreamRes.pause();
            res.once('drain', onDrain);
          }
        };

        const onData = (chunk: Buffer) => {
          observeReasoningChunk(chunk);
          usageDetector.push(chunk);
          forwardChunk(chunk);
        };
        const onEnd = () => {
          upstreamEnded = true;
          if (reasoningObserver?.finish() && !reasoningCacheLogged) {
            reasoningCacheLogged = true;
            log('info', '[reasoning] Cached reasoning context from streaming response');
          }
          if (
            reasoningEligible &&
            statusCode >= 200 &&
            statusCode < 300 &&
            !usageDetector.hasUsage() &&
            !res.destroyed &&
            res.writable
          ) {
            const finalContent = reasoningObserver
              ? reasoningObserver.capturedContent()
              : '';
            const usage = estimateUsage(requestMessages, finalContent);
            const frame = formatUsageSseFrame(usage, preparedRequest.model);
            try {
              res.write(frame);
              log(
                'info',
                `[usage] Upstream did not return usage, estimated frame added prompt≈${usage.prompt_tokens} completion≈${usage.completion_tokens}`
              );
            } catch {
            }
          }
          res.end();
          finish();
        };
        const onUpstreamError = (err: Error) => {
          log('error', `[stream] Stream disconnected mid-way: ${err.message}`);
          if (!res.destroyed) {
            res.destroy(err);
          }
          finish(err);
        };
        const onUpstreamAborted = () => {
          onUpstreamError(new Error('upstream response aborted'));
        };
        const onDownstreamError = (err: Error) => {
          if (!upstreamRes.destroyed) {
            upstreamRes.destroy(err);
          }
          finish(err);
        };
        const onDownstreamClose = () => {
          if (!upstreamEnded && !upstreamRes.destroyed) {
            upstreamRes.destroy();
          }
          finish();
        };

        upstreamRes.on('data', onData);
        upstreamRes.once('end', onEnd);
        upstreamRes.once('error', onUpstreamError);
        upstreamRes.once('aborted', onUpstreamAborted);
        res.once('error', onDownstreamError);
        res.once('close', onDownstreamClose);

        if (firstChunk.length > 0) {
          forwardChunk(firstChunk);
        }
        if (!waitingForDrain) {
          upstreamRes.resume();
        }
      });
      return;
    } catch (err) {
      lastError = err as Error;
      log('error', `[attempt ${attempt + 1}] Request failed: ${(err as Error).message}`);
      if (res.headersSent) {
        if (!res.destroyed) {
          res.destroy(err as Error);
        }
        return;
      }
      if (attempt < config.maxRetries) {
        continue;
      }
    }
  }

  log('error', '[fatal] All retries exhausted');
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'All retries exhausted',
        lastError: lastError ? lastError.message : null,
        lastStatus,
      })
    );
  } else if (!res.destroyed) {
    res.destroy(lastError ?? undefined);
  }
}

export class RetryProxy {
  private server: http.Server | null = null;
  private logBuffer: { time: string; level: LogLevel; message: string }[] = [];
  private readonly maxLogEntries = 500;
  private readonly reasoningBridge = new ReasoningBridge();

  constructor(private config: ProxyConfig, private log: LogCallback) {}

  private pushLog(level: LogLevel, message: string): void {
    const entry = { time: new Date().toISOString(), level, message };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogEntries) {
      this.logBuffer.shift();
    }
    this.log(level, message);
  }

  async start(): Promise<void> {
    if (this.server) {
      this.pushLog('info', 'Proxy is already running');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        handleRequest(
          req,
          res,
          this.config,
          (lvl, msg) => this.pushLog(lvl, msg),
          this.reasoningBridge
        ).catch(
          (err) => {
            this.pushLog('error', `handleRequest exception: ${(err as Error).message}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal proxy error' }));
            }
          }
        );
      });

      this.server.on('error', (err) => {
        this.pushLog('error', `Server error: ${err.message}`);
        this.server = null;
        // Provide more user-friendly error messages
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} is already in use, please change the port or close the occupying process`));
        } else if ((err as NodeJS.ErrnoException).code === 'EACCES') {
          reject(new Error(`Port ${this.config.port} requires administrator privileges, please use a higher port or run as administrator`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        this.pushLog('info', `Proxy started: http://127.0.0.1:${this.config.port}`);
        for (const [prefix, base] of Object.entries(this.config.upstreams)) {
          this.pushLog('info', `  ${prefix}/* → ${base}/*`);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this.pushLog('info', 'Proxy is not running');
      return;
    }
    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.pushLog('info', 'Proxy stopped');
        this.server = null;
        agentManager.destroyAll();
        this.reasoningBridge.clear();
        resolve();
      });
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getLogs(): { time: string; level: LogLevel; message: string }[] {
    return [...this.logBuffer];
  }

  getConfig(): ProxyConfig {
    return { ...this.config };
  }

  updateConfig(config: ProxyConfig): void {
    this.config = config;
    this.pushLog('info', 'Proxy config hot-updated');
  }
}
