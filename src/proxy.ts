import * as http from 'http';
import * as https from 'https';
import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import {
  PreparedChatRequest,
  ReasoningBridge,
  ResponseContext,
} from './reasoningBridge';

export interface ProxyConfig {
  port: number;
  maxRetries: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  upstreams: Record<string, string>;
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
  if (/^(aws4-hmac|hmac|signature|digest)\b/i.test(authorization)) {
    return true;
  }
  const signatureHeaders = new Set([
    'content-digest',
    'digest',
    'x-amz-content-sha256',
    'x-body-signature',
    'x-content-signature',
    'x-signature',
  ]);
  return Object.keys(headers).some((key) =>
    signatureHeaders.has(key.toLowerCase())
  );
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

// Agent 连接池管理器（HTTP keep-alive）
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
  // 移除可能导致 HMAC 签名验证失败的请求头
  // 这些头通常包含时间戳、请求ID等，重试时会导致签名不匹配
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
      // Only structured error envelopes count. Never inspect normal content or
      // reasoning text, which may legitimately discuss rate limits/errors.
      if (record.error) return true;
      if (record.type === 'error' && record.message) return true;
    } catch {
      // An incomplete first SSE event is not enough evidence to retry.
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
  let preparedRequest: PreparedChatRequest = {
    body: reqBody,
    injectedCount: 0,
  };
  let responseContext: ResponseContext | undefined;
  if (reasoningEligible && !isSignedRequest(rawHeaders)) {
    const scope = reasoningScope(targetUrl, rawHeaders);
    preparedRequest = reasoningBridge.prepareRequest(reqBody, scope);
    responseContext = {
      scope,
      model: preparedRequest.model,
      requestFingerprint: preparedRequest.requestFingerprint,
    };
    // Make the observation tap see plain SSE/JSON while forwarding semantics stay unchanged.
    rawHeaders['accept-encoding'] = 'identity';
    if (preparedRequest.injectedCount > 0) {
      log(
        'info',
        `[reasoning] 已为 ${preparedRequest.injectedCount} 条 assistant 消息回填 reasoning_content`
      );
    }
  } else if (reasoningEligible) {
    log('warn', '[reasoning] 请求包含内容签名，已跳过 reasoning_content 注入');
  }
  // 第一次使用原始 headers（包含签名），重试时需要过滤签名头
  const reqHeaders = rawHeaders;

  let lastError: Error | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt - 1, config);
        log('info', `[retry ${attempt}/${config.maxRetries}] 等待 ${delay}ms 后重试 ${maskUrl(targetUrl)}`);
        await sleep(delay);
      }

      // 重试时过滤签名头（移除时间戳/请求ID等导致 HMAC 验证失败的头）
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
          log('warn', `[retry] 触发重试: status=${statusCode} body=${bodyText.slice(0, 200)}`);
          continue;
        }

        if (
          responseContext &&
          statusCode >= 200 &&
          statusCode < 300 &&
          reasoningBridge.captureJsonResponse(body, responseContext)
        ) {
          log('info', '[reasoning] 已缓存非流式响应的思考上下文');
        }

        res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
        res.end(body);
        return;
      }

      let firstChunk: Buffer;
      try {
        const sniffed = await sniffFirstChunk(upstreamRes);
        if (sniffed.kind === 'retry') {
          if (attempt < config.maxRetries) {
            log('warn', '[retry] 流首帧携带结构化错误信号，准备重试');
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
        if (attempt < config.maxRetries && isNetworkError(err as Error)) {
          log('warn', `[retry] 嗅探首帧网络错误，尝试重试: ${(err as Error).message}`);
          upstreamRes.destroy();
          continue;
        }
        log('error', `[stream] 嗅探首帧失败: ${(err as Error).message}`);
        if (attempt < config.maxRetries) {
          upstreamRes.destroy();
          continue;
        }
        // 所有重试都失败，必须响应客户端，否则客户端会一直挂起
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sniff failed', message: (err as Error).message }));
        } else if (!res.destroyed) {
          res.destroy(err as Error);
        }
        return;
      }

      // 流式传输：首帧嗅探会 pause 上游；安装完整的事件与背压处理后再 resume。
      res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
      const reasoningObserver =
        responseContext && statusCode >= 200 && statusCode < 300
          ? reasoningBridge.observeStream(responseContext)
          : undefined;
      let reasoningCacheLogged = false;
      const observeReasoningChunk = (chunk: Buffer) => {
        if (reasoningObserver?.push(chunk) && !reasoningCacheLogged) {
          reasoningCacheLogged = true;
          log('info', '[reasoning] 已缓存流式响应的思考上下文');
        }
      };
      observeReasoningChunk(firstChunk);

      const idleTimeoutMs = 60000; // 60 秒无数据视为超时
      let idleTimer: NodeJS.Timeout | null = null;

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          log('warn', `[stream] 上游无数据超过 ${idleTimeoutMs}ms，触发超时断开`);
          upstreamRes.destroy(new Error('upstream idle timeout'));
        }, idleTimeoutMs);
      };

      resetIdleTimer();

      // 等待流完成（处理 end/error/close、下游背压，并防止重复结束）。
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
          forwardChunk(chunk);
        };
        const onEnd = () => {
          upstreamEnded = true;
          if (reasoningObserver?.finish() && !reasoningCacheLogged) {
            reasoningCacheLogged = true;
            log('info', '[reasoning] 已缓存流式响应的思考上下文');
          }
          res.end();
          finish();
        };
        const onUpstreamError = (err: Error) => {
          log('error', `[stream] 流中途断开: ${err.message}`);
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
      log('error', `[attempt ${attempt + 1}] 请求失败: ${(err as Error).message}`);
      // 如果已经向客户端发送了响应头，就不能再重试了
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

  log('error', '[fatal] 所有重试均失败');
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
      this.pushLog('info', '代理已在运行中');
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
            this.pushLog('error', `handleRequest 异常: ${(err as Error).message}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal proxy error' }));
            }
          }
        );
      });

      this.server.on('error', (err) => {
        this.pushLog('error', `服务器错误: ${err.message}`);
        this.server = null;
        reject(err);
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        this.pushLog('info', `代理已启动: http://127.0.0.1:${this.config.port}`);
        for (const [prefix, base] of Object.entries(this.config.upstreams)) {
          this.pushLog('info', `  ${prefix}/* → ${base}/*`);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this.pushLog('info', '代理未运行');
      return;
    }
    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.pushLog('info', '代理已停止');
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
}
