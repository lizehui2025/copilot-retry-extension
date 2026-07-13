import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

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

function getBackoffDelay(retryCount: number, config: ProxyConfig): number {
  const base = Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, retryCount),
    config.maxBackoffMs
  );
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeRequest(
  targetUrl: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  bodyBuffer: Buffer
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;

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

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: reqHeaders as http.OutgoingHttpHeaders,
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
  const text = firstChunk.toString('utf8').slice(0, 2048).toLowerCase();
  if (!text) return false;
  const jsonFragments = text.match(/\{[^]*\}/g) || [];
  for (const fragment of jsonFragments) {
    if (
      fragment.includes('"type"') &&
      fragment.includes('"error"') &&
      (fragment.includes('server_error') ||
        fragment.includes('server_is_overloaded') ||
        fragment.includes('rate_limit') ||
        fragment.includes('too_many_requests') ||
        fragment.includes('overloaded'))
    ) {
      return true;
    }
  }
  return (
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('server is overloaded')
  );
}

function sniffFirstChunk(
  upstreamRes: http.IncomingMessage
): Promise<{ kind: 'retry' | 'stream'; firstChunk: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onChunk = (chunk: Buffer) => {
      if (settled) return;
      settled = true;
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
      cleanup();
      resolve({ kind: 'retry', firstChunk: Buffer.alloc(0) });
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      upstreamRes.removeListener('data', onChunk);
      upstreamRes.removeListener('end', onEnd);
      upstreamRes.removeListener('error', onError);
    };
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
  log: LogCallback
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

  const reqHeaders: Record<string, string | string[] | undefined> = { ...req.headers };

  let lastError: Error | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt - 1, config);
        log('info', `[retry ${attempt}/${config.maxRetries}] 等待 ${delay}ms 后重试 ${maskUrl(targetUrl)}`);
        await sleep(delay);
      }

      log('info', `${req.method} ${maskUrl(targetUrl)} (attempt ${attempt + 1})`);

      const upstreamRes = await makeRequest(targetUrl, req.method || 'GET', reqHeaders, reqBody);
      const statusCode = upstreamRes.statusCode || 500;
      lastStatus = statusCode;

      if (shouldRetry(statusCode, '') || !isStreamingResponse(upstreamRes)) {
        const body = await collectResponse(upstreamRes);
        const bodyText = body.toString('utf8');
        if (shouldRetry(statusCode, bodyText) && attempt < config.maxRetries) {
          log('warn', `[retry] 触发重试: status=${statusCode} body=${bodyText.slice(0, 200)}`);
          continue;
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
            log('warn', `[retry] 流首帧携带错误信号，重试: ${sniffed.firstChunk.toString('utf8').slice(0, 200)}`);
            continue;
          }
          res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
          res.end(sniffed.firstChunk);
          return;
        }
        firstChunk = sniffed.firstChunk;
      } catch (err) {
        log('error', `[stream] 嗅探首帧失败: ${(err as Error).message}`);
        if (attempt < config.maxRetries) {
          continue;
        }
        throw err;
      }

      res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
      if (firstChunk.length > 0) {
        res.write(firstChunk);
      }
      upstreamRes.pipe(res);
      upstreamRes.on('error', (err) => {
        log('error', `[stream] 流已开始，中途断开不可重试: ${err.message}`);
        res.destroy(err);
      });
      res.on('close', () => {
        if (!upstreamRes.destroyed) {
          upstreamRes.destroy();
        }
      });
      return;
    } catch (err) {
      lastError = err as Error;
      log('error', `[attempt ${attempt + 1}] 请求失败: ${(err as Error).message}`);
      if (attempt < config.maxRetries) {
        continue;
      }
    }
  }

  log('error', '[fatal] 所有重试均失败');
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: 'All retries exhausted',
      lastError: lastError ? lastError.message : null,
      lastStatus,
    })
  );
}

export class RetryProxy {
  private server: http.Server | null = null;
  private logBuffer: { time: string; level: LogLevel; message: string }[] = [];
  private readonly maxLogEntries = 500;

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
        handleRequest(req, res, this.config, (lvl, msg) => this.pushLog(lvl, msg)).catch(
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
