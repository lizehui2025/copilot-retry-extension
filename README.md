# Copilot Retry Proxy

Local retry proxy VS Code extension that auto-retries third-party Chat model API rate limit errors (429 / 5xx / 11210).

## Features

- Local HTTP proxy listening on `127.0.0.1:8787`, forwarding to real upstream by path prefix
- Exponential backoff + jitter retry strategy, respecting `retry-after` / `retry-after-ms` headers
- Streaming response first-frame sniffing: first-frame errors are retryable; no mid-stream reconnection once stream has started
- Thinking mode compatibility: caches `reasoning_content` from responses and auto-backfills when missing in subsequent tool call / conversation requests
- Auto-rewrite `chatLanguageModels.json` to hijack third-party model traffic to the local proxy
- Creates `.bak` backup in the same directory before rewriting
- Status bar ON/OFF visualization, auto-restart on config change

Thinking content is stored only in the extension process memory, isolated by upstream, model, and API credentials; it is never written to disk or logged, and is cleared when the proxy stops.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotRetryProxy.enabled` | `true` | Auto-start proxy on launch |
| `copilotRetryProxy.port` | `8787` | Listen port |
| `copilotRetryProxy.maxRetries` | `5` | Maximum retry count |
| `copilotRetryProxy.initialBackoffMs` | `1000` | Initial backoff (ms) |
| `copilotRetryProxy.backoffMultiplier` | `2` | Backoff multiplier |
| `copilotRetryProxy.maxBackoffMs` | `30000` | Maximum backoff (ms) |
| `copilotRetryProxy.upstreams` | `{}` | Manual upstream mapping (overrides auto-read) |

## Commands

- `Copilot Retry Proxy: Start Proxy`
- `Copilot Retry Proxy: Stop Proxy`
- `Copilot Retry Proxy: Restart Proxy`
- `Copilot Retry Proxy: Show Status`
- `Copilot Retry Proxy: Show Log`

## Platform Support

Auto-detects `chatLanguageModels.json` location, covering:
- Linux: `~/.config/Code/User`, `Code - Insiders`, `VSCodium`, `Cursor`
- macOS: `~/Library/Application Support/{...}/User`
- Windows: `%APPDATA%\{...}\User`

## Development

```bash
npm install
npm run compile      # Compile TS → out/
npm run watch        # Watch mode
npm test             # Run SSE and reasoning_content regression tests
npm run lint         # TypeScript type check
```

## Restoring chatLanguageModels.json

The proxy creates `chatLanguageModels.json.bak` in the same directory as the original file. You can directly use that file to restore.
