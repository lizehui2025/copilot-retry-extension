# Changelog

## [0.0.7] - 2026-07-15

### Fixed
- Compatible with Copilot splitting multi-tool responses into multiple assistant messages: tool call IDs ignore `__vscode-*` execution suffixes and allow safe matching of thinking content using a subset of the original response tool set.
- When Copilot only keeps `reasoning`, automatically promote it to the upstream-required `reasoning_content`; `cot_summary` serves as a compatibility fallback.

### Added
- For each thinking mode request, log the total assistant count, original missing count, cache backfill count, and unresolved tool message count — without logging message body or thinking content.

## [0.0.6] - 2026-07-15

### Fixed
- Fixed an issue where DeepSeek thinking-mode responses that only output `reasoning_content` (with `content` as an empty string and no `tool_calls`) were incorrectly discarded by `ReasoningBridge.record()`. Previously, such responses were ignored due to the `(!content && !toolCalls)` filter condition, causing the next request to fail to backfill `reasoning_content`, resulting in upstream API error 400 `10305` ("The reasoning_content in the thinking mode must be passed back to the API.").

## [0.0.5] - 2026-07-14

### Added
- Thinking mode compatibility: cache `reasoning_content` from streaming/non-streaming responses, auto-backfill in subsequent tool call requests
- Upstream mapping auto-recovery: restore lost upstream mappings from `.bak` backup, extension storage, and local history
- `copilotRetryProxy.openConfig` command: open the upstream config file in the editor

### Changed
- Improved first-frame sniffing logic for streaming, refined retryable error conditions
- HTTP connection pool management, improved proxy forwarding performance
- Upstream mapping disk persistence uses atomic writes (temp file + rename) to prevent corruption on power loss
- Force-ensure upstream mapping is safely persisted before rewriting `chatLanguageModels.json`

### Fixed
- Fixed unregistered `openConfig` command

## [0.0.4] - 2026-07-10

### Added
- Exponential backoff + jitter retry strategy, respecting `retry-after` / `retry-after-ms` headers
- Streaming response first-frame error sniffing; no mid-stream reconnection once stream has started
- Status bar ON/OFF visualization, auto-restart on config change
- Auto-detect `chatLanguageModels.json` path across multiple platforms

### Changed
- Create `.bak` backup before rewriting `chatLanguageModels.json`

## [0.0.3] - 2026-07-08

### Added
- Support auto path detection for Windows / macOS / Linux
- Command palette integration: start/stop/restart/show status/show log

## [0.0.2] - 2026-07-05

### Added
- Local HTTP proxy, forwarding to real upstream by path prefix
- Auto-rewrite `chatLanguageModels.json` to hijack third-party model traffic
- Auto-retry on 429 / 5xx / 11210 errors

## [0.0.1] - 2026-07-01

- Initial release
