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

export interface ChatMessage {
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

interface ChatTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface CapturedAssistantResponse {
  reasoningContent: string;
  content: string;
  toolCalls: ToolCall[];
  usage?: ChatTokenUsage;
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
  promotedAliasCount: number;
  assistantCount: number;
  missingReasoningCount: number;
  unresolvedCount: number;
  unresolvedToolCallCount: number;
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

function messagesFingerprint(messages: ChatMessage[]): string {
  const withoutReasoning = messages.map((message) => {
    if (!message || message.role !== 'assistant') {
      return message;
    }
    const clone = { ...message };
    delete clone.reasoning_content;
    delete clone.reasoning;
    delete clone.cot_summary;
    return clone;
  });
  return fingerprint(withoutReasoning);
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
    .map(normalizeToolCallId)
    .sort();
}

function normalizeToolCallId(id: string): string {
  return id.replace(/__vscode-\d+$/, '');
}

function isStringSubset(subset: string[], values: string[]): boolean {
  return subset.length > 0 && subset.every((value) => values.includes(value));
}

function reasoningAliasText(message: ChatMessage): string {
  for (const key of ['reasoning', 'cot_summary']) {
    const value = message[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function setReasoning(message: ChatMessage, reasoning: string): void {
  message.reasoning_content = reasoning;
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
  private usage?: ChatTokenUsage;

  accept(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const record = payload as Record<string, unknown>;
    if (
      record.usage &&
      typeof record.usage === 'object' &&
      !Array.isArray(record.usage)
    ) {
      const usageRecord = record.usage as Record<string, unknown>;
      const merged: ChatTokenUsage = { ...(this.usage || {}) };
      if (typeof usageRecord.prompt_tokens === 'number') {
        merged.prompt_tokens = usageRecord.prompt_tokens;
      }
      if (typeof usageRecord.completion_tokens === 'number') {
        merged.completion_tokens = usageRecord.completion_tokens;
      }
      if (typeof usageRecord.total_tokens === 'number') {
        merged.total_tokens = usageRecord.total_tokens;
      }
      this.usage = merged;
    }
    const choices = record.choices;
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
      usage: this.usage,
    };
  }

  getContent(): string {
    return this.content;
  }

  getUsage(): ChatTokenUsage | undefined {
    return this.usage;
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

  capturedContent(): string {
    return this.accumulator.getContent();
  }

  capturedUsage(): CapturedAssistantResponse['usage'] {
    return this.accumulator.getUsage();
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
      return this.emptyPreparedRequest(body);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return this.emptyPreparedRequest(body);
    }
    if (!parsed || typeof parsed !== 'object') {
      return this.emptyPreparedRequest(body);
    }
    const request = parsed as Record<string, unknown>;
    if (!Array.isArray(request.messages)) {
      return {
        body,
        model: typeof request.model === 'string' ? request.model : undefined,
        injectedCount: 0,
        promotedAliasCount: 0,
        assistantCount: 0,
        missingReasoningCount: 0,
        unresolvedCount: 0,
        unresolvedToolCallCount: 0,
      };
    }

    this.prune();
    const messages = request.messages as ChatMessage[];
    const model = typeof request.model === 'string' ? request.model : undefined;
    const requestFingerprint = messagesFingerprint(messages);
    let injectedCount = 0;
    let promotedAliasCount = 0;
    let assistantCount = 0;
    let missingReasoningCount = 0;
    let unresolvedCount = 0;
    let unresolvedToolCallCount = 0;

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (!message || message.role !== 'assistant') continue;
      assistantCount++;
      if (
        typeof message.reasoning_content === 'string' &&
        message.reasoning_content.length > 0
      ) {
        continue;
      }
      missingReasoningCount++;
      const aliasReasoning = reasoningAliasText(message);
      if (aliasReasoning) {
        setReasoning(message, aliasReasoning);
        promotedAliasCount++;
        continue;
      }
      const entry = this.findMatch(
        message,
        messagesFingerprint(messages.slice(0, index)),
        scope,
        model
      );
      if (entry) {
        setReasoning(message, entry.reasoningContent);
        injectedCount++;
      } else {
        unresolvedCount++;
        if (messageToolCalls(message).length > 0) {
          unresolvedToolCallCount++;
        }
      }
    }

    const modifiedCount = injectedCount + promotedAliasCount;
    return {
      body:
        modifiedCount > 0
          ? Buffer.from(JSON.stringify(request), 'utf8')
          : body,
      model,
      requestFingerprint,
      injectedCount,
      promotedAliasCount,
      assistantCount,
      missingReasoningCount,
      unresolvedCount,
      unresolvedToolCallCount,
    };
  }

  private emptyPreparedRequest(body: Buffer): PreparedChatRequest {
    return {
      body,
      injectedCount: 0,
      promotedAliasCount: 0,
      assistantCount: 0,
      missingReasoningCount: 0,
      unresolvedCount: 0,
      unresolvedToolCallCount: 0,
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
      response.reasoningContent.length > this.maxReasoningChars
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
      const idsContained = isStringSubset(messageIds, entryIds);
      const toolsMatch =
        messageCalls.length > 0 &&
        messageToolSignature === toolCallSignature(entry.toolCalls);
      const contentMatches =
        messageContent.length > 0 && messageContent === entry.content;

      if (
        !idsMatch &&
        !idsContained &&
        !(contextMatches && (toolsMatch || contentMatches))
      ) {
        if (!(contextMatches && !messageContent && messageIds.length === 0)) {
          continue;
        }
      }

      const score =
        (contextMatches ? 100 : 0) +
        (idsMatch ? 80 : 0) +
        (idsContained && !idsMatch ? 60 : 0) +
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


const TOKEN_CHARS_PER_TOKEN = 4;

function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN));
}

export interface EstimatedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function estimateUsage(
  requestMessages: ChatMessage[] | undefined,
  assistantContent: string
): EstimatedUsage {
  let promptChars = 0;
  if (Array.isArray(requestMessages)) {
    for (const message of requestMessages) {
      promptChars += contentText(message.content).length;
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call?.function?.arguments) {
            promptChars += JSON.stringify(call.function.arguments).length;
          }
        }
      }
      const reasoning =
        typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : '';
      promptChars += reasoning.length;
    }
  }
  const prompt_tokens = estimateTokenCount('x'.repeat(promptChars));
  const completion_tokens = estimateTokenCount(assistantContent);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

/**
 * Inject stream_options.include_usage=true into chat-completions request body.
 * Returns the new body (Buffer) and a flag indicating whether it was modified.
 *  - Only applies to chat-completions requests where stream===true;
 *  - Skips injection if stream_options.include_usage=true is already explicitly set;
 *  - If JSON parsing fails or requestBody is not an object, returns as-is.
 */
export function ensureStreamUsageOptions(
  body: Buffer
): { body: Buffer; modified: boolean; requestMessages?: ChatMessage[] } {
  if (body.length === 0 || body.length > 16 * 1024 * 1024) {
    return { body, modified: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, modified: false };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { body, modified: false };
  }
  const request = parsed as Record<string, unknown>;
  if (request.stream !== true) {
    return {
      body,
      modified: false,
      requestMessages: Array.isArray(request.messages)
        ? (request.messages as ChatMessage[])
        : undefined,
    };
  }
  let streamOptions = request.stream_options;
  let needsInject = true;
  if (
    streamOptions &&
    typeof streamOptions === 'object' &&
    !Array.isArray(streamOptions)
  ) {
    const opts = streamOptions as Record<string, unknown>;
    if (opts.include_usage === true) {
      needsInject = false;
    } else {
      opts.include_usage = true;
    }
  } else {
    streamOptions = { include_usage: true };
    request.stream_options = streamOptions;
  }
  if (!needsInject) {
    return {
      body,
      modified: false,
      requestMessages: Array.isArray(request.messages)
        ? (request.messages as ChatMessage[])
        : undefined,
    };
  }
  if (!streamOptions || typeof streamOptions !== 'object') {
    return {
      body,
      modified: false,
      requestMessages: Array.isArray(request.messages)
        ? (request.messages as ChatMessage[])
        : undefined,
    };
  }
  (streamOptions as Record<string, unknown>).include_usage = true;
  return {
    body: Buffer.from(JSON.stringify(request), 'utf8'),
    modified: true,
    requestMessages: Array.isArray(request.messages)
      ? (request.messages as ChatMessage[])
      : undefined,
  };
}

/**
 * Format a usage frame as SSE data lines.
 * Only sent when the upstream SSE stream did not include usage at the end.
 */
export function formatUsageSseFrame(
  usage: EstimatedUsage,
  model?: string
): string {
  const payload = {
    id: 'chatcmpl-proxy-usage',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'proxy',
    choices: [],
    usage,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}
