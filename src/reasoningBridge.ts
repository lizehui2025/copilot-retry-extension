import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';

interface ToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: ToolCall[];
  function_call?: {
    name?: string;
    arguments?: unknown;
  };
  [key: string]: unknown;
}

interface CapturedAssistantResponse {
  reasoningContent: string;
  content: string;
  toolCalls: ToolCall[];
}

interface CacheEntry extends CapturedAssistantResponse {
  scope: string;
  model?: string;
  requestFingerprint?: string;
  createdAt: number;
  lastUsedAt: number;
  responseSignature: string;
}

export interface ResponseContext {
  scope: string;
  model?: string;
  requestFingerprint?: string;
}

export interface PreparedChatRequest {
  body: Buffer;
  model?: string;
  requestFingerprint?: string;
  injectedCount: number;
}

export interface ReasoningBridgeOptions {
  maxEntries?: number;
  ttlMs?: number;
  maxReasoningChars?: number;
  maxTotalReasoningChars?: number;
  maxRequestBytes?: number;
  now?: () => number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'reasoning_content') {
        continue;
      }
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (typeof record.content === 'string') return record.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function normalizeToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.map((call, position) => ({
    index: typeof call.index === 'number' ? call.index : position,
    id: typeof call.id === 'string' ? call.id : undefined,
    type: typeof call.type === 'string' ? call.type : undefined,
    function: call.function
      ? {
          name:
            typeof call.function.name === 'string'
              ? call.function.name
              : undefined,
          arguments: normalizeFunctionArguments(call.function.arguments),
        }
      : undefined,
  }));
}

function normalizeFunctionArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== 'string') {
    return argumentsValue;
  }
  try {
    return canonicalize(JSON.parse(argumentsValue));
  } catch {
    return argumentsValue;
  }
}

function toolCallIds(toolCalls: ToolCall[] | undefined): string[] {
  return normalizeToolCalls(toolCalls)
    .map((call) => call.id)
    .filter((id): id is string => Boolean(id))
    .sort();
}

function messageToolCalls(message: ChatMessage): ToolCall[] {
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls;
  }
  if (message.function_call) {
    return [
      {
        index: 0,
        type: 'function',
        function: message.function_call,
      },
    ];
  }
  return [];
}

function toolCallSignature(toolCalls: ToolCall[] | undefined): string {
  return fingerprint(normalizeToolCalls(toolCalls));
}

function responseSignature(
  content: string,
  toolCalls: ToolCall[]
): string {
  return fingerprint({ content, toolCalls: normalizeToolCalls(toolCalls) });
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

class AssistantResponseAccumulator {
  private reasoningContent = '';
  private content = '';
  private toolCalls = new Map<number, ToolCall>();

  accept(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const choices = (payload as Record<string, unknown>).choices;
    if (!Array.isArray(choices)) {
      return;
    }
    const choice = choices.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const index = (candidate as Record<string, unknown>).index;
      return index === 0 || index === undefined;
    });
    if (!choice || typeof choice !== 'object') return;
    const choiceRecord = choice as Record<string, unknown>;
    const candidate = choiceRecord.delta ?? choiceRecord.message;
    if (!candidate || typeof candidate !== 'object') return;
    const message = candidate as Record<string, unknown>;

      const reasoning =
        typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : typeof message.reasoning === 'string'
            ? message.reasoning
            : '';
      this.reasoningContent += reasoning;
      if (typeof message.content === 'string') {
        this.content += message.content;
      }

      if (Array.isArray(message.tool_calls)) {
        for (let position = 0; position < message.tool_calls.length; position++) {
          const fragment = message.tool_calls[position];
          if (!fragment || typeof fragment !== 'object') continue;
          const record = fragment as Record<string, unknown>;
          const index =
            typeof record.index === 'number' ? record.index : position;
          const existing = this.toolCalls.get(index) || { index };
          if (typeof record.id === 'string') {
            if (!existing.id) {
              existing.id = record.id;
            } else if (existing.id !== record.id) {
              existing.id += record.id;
            }
          }
          if (typeof record.type === 'string') {
            existing.type = record.type;
          }
          if (record.function && typeof record.function === 'object') {
            const fn = record.function as Record<string, unknown>;
            existing.function ||= {};
            if (typeof fn.name === 'string') {
              existing.function.name =
                (existing.function.name || '') + fn.name;
            }
            if (typeof fn.arguments === 'string') {
              const previous =
                typeof existing.function.arguments === 'string'
                  ? existing.function.arguments
                  : '';
              existing.function.arguments = previous + fn.arguments;
            }
          }
          this.toolCalls.set(index, existing);
        }
    }

    if (message.function_call && typeof message.function_call === 'object') {
        const fn = message.function_call as Record<string, unknown>;
        const existing = this.toolCalls.get(0) || { index: 0, type: 'function' };
        existing.function ||= {};
        if (typeof fn.name === 'string') {
          existing.function.name = (existing.function.name || '') + fn.name;
        }
        if (typeof fn.arguments === 'string') {
          const previous =
            typeof existing.function.arguments === 'string'
              ? existing.function.arguments
              : '';
          existing.function.arguments = previous + fn.arguments;
        }
        this.toolCalls.set(0, existing);
    }
  }

  result(): CapturedAssistantResponse {
    return {
      reasoningContent: this.reasoningContent,
      content: this.content,
      toolCalls: [...this.toolCalls.values()].sort(
        (left, right) => (left.index || 0) - (right.index || 0)
      ),
    };
  }
}

export class ReasoningStreamObserver {
  private readonly decoder = new StringDecoder('utf8');
  private readonly accumulator = new AssistantResponseAccumulator();
  private pending = '';
  private finished = false;
  private committed = false;

  constructor(
    private readonly onFinish: (
      response: CapturedAssistantResponse
    ) => boolean
  ) {}

  push(chunk: Buffer): boolean {
    if (this.finished) return false;
    this.pending += this.decoder.write(chunk);
    return this.consumeEvents(false);
  }

  finish(): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.pending += this.decoder.end();
    const committedNow = this.consumeEvents(true);
    return this.commit() || committedNow;
  }

  private consumeEvents(flush: boolean): boolean {
    let committedNow = false;
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match || match.index === undefined) break;
      const event = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      committedNow = this.acceptEvent(event) || committedNow;
    }
    if (flush && this.pending.trim()) {
      committedNow = this.acceptEvent(this.pending) || committedNow;
      this.pending = '';
    }
    return committedNow;
  }

  private acceptEvent(event: string): boolean {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim();
    if (!data) return false;
    if (data === '[DONE]') return this.commit();
    try {
      const payload: unknown = JSON.parse(data);
      this.accumulator.accept(payload);
      if (this.hasFinishReason(payload)) {
        return this.commit();
      }
    } catch {
      // Forwarding is independent of observation; malformed SSE is ignored.
    }
    return false;
  }

  private hasFinishReason(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const choices = (payload as Record<string, unknown>).choices;
    return (
      Array.isArray(choices) &&
      choices.some(
        (choice) =>
          choice &&
          typeof choice === 'object' &&
          (choice as Record<string, unknown>).finish_reason != null
      )
    );
  }

  private commit(): boolean {
    if (this.committed) return false;
    this.committed = true;
    return this.onFinish(this.accumulator.result());
  }
}

export class ReasoningBridge {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxReasoningChars: number;
  private readonly maxTotalReasoningChars: number;
  private readonly maxRequestBytes: number;
  private readonly now: () => number;
  private entries: CacheEntry[] = [];

  constructor(options: ReasoningBridgeOptions = {}) {
    this.maxEntries = options.maxEntries ?? 64;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxReasoningChars = options.maxReasoningChars ?? 2_000_000;
    this.maxTotalReasoningChars =
      options.maxTotalReasoningChars ?? 16_000_000;
    this.maxRequestBytes = options.maxRequestBytes ?? 16 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  prepareRequest(body: Buffer, scope: string): PreparedChatRequest {
    if (body.length > this.maxRequestBytes) {
      return { body, injectedCount: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return { body, injectedCount: 0 };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { body, injectedCount: 0 };
    }
    const request = parsed as Record<string, unknown>;
    if (!Array.isArray(request.messages)) {
      return {
        body,
        model: typeof request.model === 'string' ? request.model : undefined,
        injectedCount: 0,
      };
    }

    this.prune();
    const messages = request.messages as ChatMessage[];
    const model = typeof request.model === 'string' ? request.model : undefined;
    const requestFingerprint = fingerprint(messages);
    let injectedCount = 0;

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (!message || message.role !== 'assistant') continue;
      if (
        typeof message.reasoning_content === 'string' &&
        message.reasoning_content.length > 0
      ) {
        continue;
      }
      const entry = this.findMatch(
        message,
        fingerprint(messages.slice(0, index)),
        scope,
        model
      );
      if (entry) {
        message.reasoning_content = entry.reasoningContent;
        injectedCount++;
      }
    }

    return {
      body: injectedCount > 0 ? Buffer.from(JSON.stringify(request), 'utf8') : body,
      model,
      requestFingerprint,
      injectedCount,
    };
  }

  observeStream(context: ResponseContext): ReasoningStreamObserver {
    return new ReasoningStreamObserver((response) =>
      this.record(response, context)
    );
  }

  captureJsonResponse(body: Buffer, context: ResponseContext): boolean {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      const accumulator = new AssistantResponseAccumulator();
      accumulator.accept(parsed);
      return this.record(accumulator.result(), context);
    } catch {
      return false;
    }
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    this.prune();
    return this.entries.length;
  }

  private record(
    response: CapturedAssistantResponse,
    context: ResponseContext
  ): boolean {
    if (
      !response.reasoningContent ||
      response.reasoningContent.length > this.maxReasoningChars ||
      (!response.content && response.toolCalls.length === 0)
    ) {
      return false;
    }
    this.prune();
    const signature = responseSignature(response.content, response.toolCalls);
    this.entries = this.entries.filter(
      (entry) =>
        !(
          entry.scope === context.scope &&
          entry.model === context.model &&
          entry.requestFingerprint === context.requestFingerprint &&
          entry.responseSignature === signature &&
          entry.reasoningContent === response.reasoningContent
        )
    );
    this.entries.unshift({
      ...response,
      scope: context.scope,
      model: context.model,
      requestFingerprint: context.requestFingerprint,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      responseSignature: signature,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    while (
      this.entries.reduce(
        (total, entry) => total + entry.reasoningContent.length,
        0
      ) > this.maxTotalReasoningChars
    ) {
      this.entries.pop();
    }
    return true;
  }

  private findMatch(
    message: ChatMessage,
    prefixFingerprint: string,
    scope: string,
    model?: string
  ): CacheEntry | undefined {
    const messageCalls = messageToolCalls(message);
    const messageIds = toolCallIds(messageCalls);
    const messageToolSignature = toolCallSignature(messageCalls);
    const messageContent = contentText(message.content);
    let best: { entry: CacheEntry; score: number } | undefined;
    let ambiguous = false;

    for (const entry of this.entries) {
      if (entry.scope !== scope) continue;
      if (model && entry.model && model !== entry.model) continue;

      const contextMatches = entry.requestFingerprint === prefixFingerprint;
      const entryIds = toolCallIds(entry.toolCalls);
      const idsMatch =
        messageIds.length > 0 && sameStrings(messageIds, entryIds);
      const toolsMatch =
        messageCalls.length > 0 &&
        messageToolSignature === toolCallSignature(entry.toolCalls);
      const contentMatches =
        messageContent.length > 0 && messageContent === entry.content;

      if (!idsMatch && !(contextMatches && (toolsMatch || contentMatches))) {
        if (!(contextMatches && !messageContent && messageIds.length === 0)) {
          continue;
        }
      }

      const score =
        (contextMatches ? 100 : 0) +
        (idsMatch ? 80 : 0) +
        (toolsMatch ? 40 : 0) +
        (contentMatches ? 20 : 0);
      if (!best || score > best.score) {
        best = { entry, score };
        ambiguous = false;
      } else if (
        score === best.score &&
        entry.reasoningContent !== best.entry.reasoningContent
      ) {
        ambiguous = true;
      }
    }
    if (best && !ambiguous) {
      best.entry.lastUsedAt = this.now();
    }
    return ambiguous ? undefined : best?.entry;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    this.entries = this.entries.filter((entry) => entry.lastUsedAt >= cutoff);
  }
}
