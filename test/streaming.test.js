const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { RetryProxy } = require('../out/proxy.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function getFreePort() {
  const server = http.createServer();
  return listen(server).then(async (port) => {
    await close(server);
    return port;
  });
}

function postJson(port, pathname, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          authorization: 'Bearer integration-test-key',
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('forwards every SSE chunk after sniffing the first frame', async () => {
  const frames = [
    'data: {"delta":"the"}\n\n',
    'data: {"delta":" quick"}\n\n',
    'data: {"delta":" brown fox"}\n\n',
    'data: [DONE]\n\n',
  ];

  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    frames.forEach((frame, index) => {
      setTimeout(() => {
        res.write(frame);
        if (index === frames.length - 1) res.end();
      }, index * 15);
    });
  });

  const upstreamPort = await listen(upstream);
  const proxyPort = await getFreePort();
  const proxy = new RetryProxy(
    {
      port: proxyPort,
      maxRetries: 0,
      initialBackoffMs: 10,
      backoffMultiplier: 2,
      maxBackoffMs: 100,
      upstreams: { '/mock': `http://127.0.0.1:${upstreamPort}` },
    },
    () => {}
  );

  try {
    await proxy.start();
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${proxyPort}/mock/v1/chat/completions`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    assert.equal(body, frames.join(''));
  } finally {
    await proxy.stop();
    await close(upstream);
  }
});

test('injects captured reasoning before the next proxied tool request', async () => {
  const initialMessages = [{ role: 'user', content: 'inspect the file' }];
  let requestNumber = 0;
  let secondUpstreamBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestNumber++;

    if (requestNumber === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"hidden-plan"}}]}\n\n'
      );
      res.write(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
      );
      res.end('data: [DONE]\n\n');
      return;
    }

    secondUpstreamBody = parsed;
    const responseBody = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'complete' } }],
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(responseBody)),
    });
    res.end(responseBody);
  });

  const upstreamPort = await listen(upstream);
  const proxyPort = await getFreePort();
  const proxy = new RetryProxy(
    {
      port: proxyPort,
      maxRetries: 0,
      initialBackoffMs: 10,
      backoffMultiplier: 2,
      maxBackoffMs: 100,
      upstreams: { '/mock': `http://127.0.0.1:${upstreamPort}` },
    },
    () => {}
  );

  try {
    await proxy.start();
    const first = await postJson(proxyPort, '/mock/v1/chat/completions', {
      model: 'DeepSeek-V4-Flash',
      messages: initialMessages,
      stream: true,
    });
    assert.equal(first.statusCode, 200);
    assert.match(first.body, /call_1/);

    const second = await postJson(proxyPort, '/mock/v1/chat/completions', {
      model: 'DeepSeek-V4-Flash',
      messages: [
        ...initialMessages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"x"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      ],
      stream: false,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(
      secondUpstreamBody.messages[1].reasoning_content,
      'hidden-plan'
    );
    assert.equal(secondUpstreamBody.messages[1].reasoning, undefined);
  } finally {
    await proxy.stop();
    await close(upstream);
  }
});
