const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ReasoningBridge,
  ensureStreamUsageOptions,
  estimateUsage,
  formatUsageSseFrame,
} = require('../out/reasoningBridge.js');

test('ensureStreamUsageOptions injects include_usage only for stream=true requests', () => {
  const streaming = Buffer.from(
    JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
  );
  const result = ensureStreamUsageOptions(streaming);
  assert.equal(result.modified, true);
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.deepEqual(parsed.stream_options, { include_usage: true });
  assert.ok(Array.isArray(result.requestMessages));
});

test('ensureStreamUsageOptions is idempotent when include_usage already set', () => {
  const already = Buffer.from(
    JSON.stringify({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    })
  );
  const result = ensureStreamUsageOptions(already);
  assert.equal(result.modified, false);
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.deepEqual(parsed.stream_options, { include_usage: true });
});

test('ensureStreamUsageOptions leaves non-stream requests untouched', () => {
  const nonStream = Buffer.from(
    JSON.stringify({ stream: false, messages: [] })
  );
  const result = ensureStreamUsageOptions(nonStream);
  assert.equal(result.modified, false);
  assert.equal(result.body, nonStream);
});

test('ensureStreamUsageOptions returns body unchanged for invalid JSON', () => {
  const junk = Buffer.from('not-json', 'utf8');
  const result = ensureStreamUsageOptions(junk);
  assert.equal(result.modified, false);
  assert.equal(result.body, junk);
});

test('estimateUsage computes prompt and completion token counts', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'a'.repeat(40) },
  ];
  const usage = estimateUsage(messages, 'b'.repeat(30));
  assert.ok(usage.prompt_tokens > 0);
  assert.ok(usage.completion_tokens > 0);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
});

test('formatUsageSseFrame emits a data line containing prompt_tokens', () => {
  const usage = estimateUsage([{ role: 'user', content: 'hi' }], 'yo');
  const frame = formatUsageSseFrame(usage, 'glm-5.2');
  assert.ok(frame.startsWith('data: '));
  assert.ok(frame.endsWith('\n\n'));
  assert.ok(frame.includes('"prompt_tokens"'));
  assert.ok(frame.includes('"completion_tokens"'));
  assert.ok(frame.includes('"total_tokens"'));
  assert.ok(frame.includes('"glm-5.2"'));
});

test('ReasoningStreamObserver exposes captured usage after stream end', () => {
  const bridge = new ReasoningBridge();
  const prepared = bridge.prepareRequest(
    Buffer.from(
      JSON.stringify({
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
    'scope-x'
  );
  const observer = bridge.observeStream({
    scope: 'scope-x',
    model: prepared.model,
    requestFingerprint: prepared.requestFingerprint,
  });

  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" world"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  observer.push(Buffer.from(sse, 'utf8'));
  observer.finish();

  assert.equal(observer.capturedContent(), 'hello world');
  assert.deepEqual(observer.capturedUsage(), {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
  });
});

test('ReasoningStreamObserver still works without usage frames', () => {
  const bridge = new ReasoningBridge();
  const prepared = bridge.prepareRequest(
    Buffer.from(
      JSON.stringify({
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
    'scope-y'
  );
  const observer = bridge.observeStream({
    scope: 'scope-y',
    model: prepared.model,
    requestFingerprint: prepared.requestFingerprint,
  });

  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"only text"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{}}],"finish_reason":"stop"}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  observer.push(Buffer.from(sse, 'utf8'));
  observer.finish();

  assert.equal(observer.capturedContent(), 'only text');
  assert.equal(observer.capturedUsage(), undefined);
});
