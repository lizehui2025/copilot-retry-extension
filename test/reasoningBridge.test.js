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
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"仔细"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考"}}]}\n\n',
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
  assert.equal(parsed.messages[2].reasoning_content, '仔细思考');
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
