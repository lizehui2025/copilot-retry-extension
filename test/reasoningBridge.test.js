const assert = require('node:assert/strict');
const test = require('node:test');
const { ReasoningBridge } = require('../out/reasoningBridge.js');

const scope = 'scope-a';
const model = 'DeepSeek-V4-Flash';

function request(messages, selectedModel = model) {
  return Buffer.from(JSON.stringify({ model: selectedModel, messages }));
}

function contextFor(prepared, selectedScope = scope) {
  return {
    scope: selectedScope,
    model: prepared.model,
    requestFingerprint: prepared.requestFingerprint,
  };
}

test('captures fragmented SSE reasoning and injects it into a tool-result request', () => {
  const bridge = new ReasoningBridge();
  const initialMessages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Read x.' },
  ];
  const prepared = bridge.prepareRequest(request(initialMessages), scope);
  const observer = bridge.observeStream(contextFor(prepared));

  const sse = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Careful"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"abc","function":{"name":"file","arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const bytes = Buffer.from(sse, 'utf8');
  let committedBeforeDone = false;
  for (let offset = 0; offset < bytes.length; ) {
    const width = Math.min((offset % 7) + 1, bytes.length - offset);
    const chunk = bytes.subarray(offset, offset + width);
    if (observer.push(chunk)) committedBeforeDone = true;
    offset += width;
  }
  assert.equal(committedBeforeDone, true);
  assert.equal(observer.finish(), false);
  assert.equal(bridge.size, 1);

  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"x"}' },
      },
    ],
  };
  const followup = bridge.prepareRequest(
    request([
      ...initialMessages,
      assistant,
      { role: 'tool', tool_call_id: 'call_abc', content: 'contents' },
    ]),
    scope
  );
  const parsed = JSON.parse(followup.body.toString('utf8'));
  assert.equal(followup.injectedCount, 1);
  assert.equal(parsed.messages[2].reasoning_content, 'Carefulthinking');
});

test('restores reasoning for every historical assistant message', () => {
  const bridge = new ReasoningBridge();
  const firstInput = [{ role: 'user', content: 'one' }];
  const first = bridge.prepareRequest(request(firstInput), scope);
  assert.equal(
    bridge.captureJsonResponse(
      Buffer.from(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                reasoning_content: 'reason-one',
                content: 'answer-one',
              },
            },
          ],
        })
      ),
      contextFor(first)
    ),
    true
  );

  const secondInput = [
    ...firstInput,
    { role: 'assistant', content: 'answer-one' },
    { role: 'user', content: 'two' },
  ];
  const second = bridge.prepareRequest(request(secondInput), scope);
  assert.equal(second.injectedCount, 1);
  assert.equal(
    bridge.captureJsonResponse(
      Buffer.from(
        JSON.stringify({
          choices: [
            {
              message: {
                reasoning_content: 'reason-two',
                content: 'answer-two',
              },
            },
          ],
        })
      ),
      contextFor(second)
    ),
    true
  );

  const third = bridge.prepareRequest(
    request([
      ...secondInput,
      { role: 'assistant', content: 'answer-two' },
      { role: 'user', content: 'three' },
    ]),
    scope
  );
  const parsed = JSON.parse(third.body.toString('utf8'));
  assert.equal(third.injectedCount, 2);
  assert.equal(parsed.messages[1].reasoning_content, 'reason-one');
  assert.equal(parsed.messages[3].reasoning_content, 'reason-two');
});

test('does not overwrite caller reasoning or cross scope/model boundaries', () => {
  const bridge = new ReasoningBridge();
  const input = [{ role: 'user', content: 'work' }];
  const prepared = bridge.prepareRequest(request(input), scope);
  const observer = bridge.observeStream(contextFor(prepared));
  observer.push(
    Buffer.from(
      'data: {"choices":[{"delta":{"reasoning_content":"secret","content":"ok"},"finish_reason":"stop"}]}\n\n'
    )
  );

  const existing = bridge.prepareRequest(
    request([
      ...input,
      {
        role: 'assistant',
        content: 'ok',
        reasoning_content: 'caller-value',
      },
    ]),
    scope
  );
  assert.equal(existing.injectedCount, 0);

  const otherScope = bridge.prepareRequest(
    request([...input, { role: 'assistant', content: 'ok' }]),
    'scope-b'
  );
  assert.equal(otherScope.injectedCount, 0);

  const otherModel = bridge.prepareRequest(
    request([...input, { role: 'assistant', content: 'ok' }], 'other-model'),
    scope
  );
  assert.equal(otherModel.injectedCount, 0);
});

test('does not cache incomplete streams and expires cached reasoning', () => {
  let now = 1000;
  const bridge = new ReasoningBridge({ ttlMs: 100, now: () => now });
  const input = [{ role: 'user', content: 'hello' }];
  const prepared = bridge.prepareRequest(request(input), scope);
  const incomplete = bridge.observeStream(contextFor(prepared));
  incomplete.push(
    Buffer.from(
      'data: {"choices":[{"delta":{"reasoning_content":"partial","content":"x"}}]}\n\n'
    )
  );
  assert.equal(bridge.size, 0);

  const complete = bridge.observeStream(contextFor(prepared));
  complete.push(
    Buffer.from(
      'data: {"choices":[{"delta":{"reasoning_content":"full","content":"x"},"finish_reason":"stop"}]}\n\n'
    )
  );
  assert.equal(bridge.size, 1);
  now += 101;
  assert.equal(bridge.size, 0);
});

test('caches reasoningContent-only responses with empty content', () => {
  // Regression: DeepSeek thinking mode sometimes only outputs reasoning_content with content as empty string.
  // Previously record would discard the response due to (!content && !toolCalls), causing the next request
  // to be missing reasoning_content, and the upstream returns 10305.
  const bridge = new ReasoningBridge();
  const input = [{ role: 'user', content: 'Calculate 1+1' }];
  const prepared = bridge.prepareRequest(request(input), scope);
  const observer = bridge.observeStream(contextFor(prepared));
  observer.push(
    Buffer.from(
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"1+1=2"}}]}\n\n'
    )
  );
  observer.push(
    Buffer.from(
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\n'
    )
  );
  observer.finish();
  assert.equal(bridge.size, 1);

  const followup = bridge.prepareRequest(
    request([
      ...input,
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Now calculate 2+2' },
    ]),
    scope
  );
  assert.equal(followup.injectedCount, 1);
  const parsed = JSON.parse(followup.body.toString('utf8'));
  assert.equal(parsed.messages[1].reasoning_content, '1+1=2');
  assert.equal(parsed.messages[1].reasoning, undefined);
});

test('promotes Copilot reasoning aliases to reasoning_content', () => {
  const bridge = new ReasoningBridge();
  const prepared = bridge.prepareRequest(
    request([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: null, reasoning: 'kept-thinking' },
      { role: 'user', content: 'two' },
    ]),
    scope
  );
  const parsed = JSON.parse(prepared.body.toString('utf8'));
  assert.equal(prepared.assistantCount, 1);
  assert.equal(prepared.missingReasoningCount, 1);
  assert.equal(prepared.promotedAliasCount, 1);
  assert.equal(prepared.unresolvedCount, 0);
  assert.equal(parsed.messages[1].reasoning_content, 'kept-thinking');
  assert.equal(parsed.messages[1].reasoning, 'kept-thinking');
});

test('uses Copilot cot_summary as a best-effort reasoning fallback', () => {
  const bridge = new ReasoningBridge();
  const prepared = bridge.prepareRequest(
    request([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: null, cot_summary: 'stored-thinking' },
      { role: 'user', content: 'two' },
    ]),
    scope
  );
  const parsed = JSON.parse(prepared.body.toString('utf8'));
  assert.equal(prepared.missingReasoningCount, 1);
  assert.equal(prepared.promotedAliasCount, 1);
  assert.equal(prepared.unresolvedCount, 0);
  assert.equal(parsed.messages[1].reasoning_content, 'stored-thinking');
  assert.equal(parsed.messages[1].cot_summary, 'stored-thinking');
});

test('matches split tool messages with VS Code id suffixes', () => {
  const bridge = new ReasoningBridge();
  const input = [{ role: 'user', content: 'use two tools' }];
  const prepared = bridge.prepareRequest(request(input), scope);
  assert.equal(
    bridge.captureJsonResponse(
      Buffer.from(
        JSON.stringify({
          choices: [
            {
              message: {
                reasoning_content: 'plan both calls',
                content: null,
                tool_calls: [
                  {
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'first', arguments: '{}' },
                  },
                  {
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'second', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        })
      ),
      contextFor(prepared)
    ),
    true
  );

  const followup = bridge.prepareRequest(
    request([
      ...input,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_a__vscode-1784087608982',
            type: 'function',
            function: { name: 'first', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_a__vscode-1784087608982',
        content: 'first result',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_b__vscode-1784087608983',
            type: 'function',
            function: { name: 'second', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_b__vscode-1784087608983',
        content: 'second result',
      },
    ]),
    scope
  );
  const parsed = JSON.parse(followup.body.toString('utf8'));
  assert.equal(followup.assistantCount, 2);
  assert.equal(followup.missingReasoningCount, 2);
  assert.equal(followup.injectedCount, 2);
  assert.equal(followup.unresolvedCount, 0);
  assert.equal(followup.unresolvedToolCallCount, 0);
  assert.equal(parsed.messages[1].reasoning_content, 'plan both calls');
  assert.equal(parsed.messages[3].reasoning_content, 'plan both calls');
});

test('reports unresolved assistant tool messages without logging content', () => {
  const bridge = new ReasoningBridge();
  const prepared = bridge.prepareRequest(
    request([
      { role: 'user', content: 'use a tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'unknown_call',
            type: 'function',
            function: { name: 'unknown', arguments: '{}' },
          },
        ],
      },
    ]),
    scope
  );
  assert.equal(prepared.assistantCount, 1);
  assert.equal(prepared.missingReasoningCount, 1);
  assert.equal(prepared.injectedCount, 0);
  assert.equal(prepared.unresolvedCount, 1);
  assert.equal(prepared.unresolvedToolCallCount, 1);
});

test('does not choose between ambiguous normalized tool ids', () => {
  const bridge = new ReasoningBridge();
  for (const [content, reasoning] of [
    ['first context', 'first reasoning'],
    ['second context', 'second reasoning'],
  ]) {
    const prepared = bridge.prepareRequest(
      request([{ role: 'user', content }]),
      scope
    );
    assert.equal(
      bridge.captureJsonResponse(
        Buffer.from(
          JSON.stringify({
            choices: [
              {
                message: {
                  reasoning_content: reasoning,
                  content: null,
                  tool_calls: [
                    {
                      id: 'same_call',
                      type: 'function',
                      function: { name: 'same', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          })
        ),
        contextFor(prepared)
      ),
      true
    );
  }

  const followup = bridge.prepareRequest(
    request([
      { role: 'user', content: 'unrelated context' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'same_call__vscode-1784087608999',
            type: 'function',
            function: { name: 'same', arguments: '{}' },
          },
        ],
      },
    ]),
    scope
  );
  assert.equal(followup.injectedCount, 0);
  assert.equal(followup.unresolvedCount, 1);
  assert.equal(followup.unresolvedToolCallCount, 1);
});
