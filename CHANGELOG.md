# Changelog

## [0.0.7] - 2026-07-15

### Fixed
- 兼容 Copilot 将多工具响应拆分为多个 assistant 消息的情况：工具调用 ID 会忽略 `__vscode-*` 执行后缀，并允许用原响应工具集合的子集安全匹配思考内容。
- 当 Copilot 仅保留 `reasoning` 时，自动提升为上游要求的 `reasoning_content`；`cot_summary` 作为兼容性兜底。

### Added
- 为每次思考模式请求记录 assistant 总数、原缺失数、缓存回填数及仍未解决的工具消息数，不记录消息正文或思考内容。

## [0.0.6] - 2026-07-15

### Fixed
- 修复 DeepSeek 思考模式只输出 `reasoning_content`（`content` 为空字符串、无 `tool_calls`）的响应被 `ReasoningBridge.record()` 误丢弃的问题。之前这类响应因 `(!content && !toolCalls)` 过滤条件被忽略，导致下一轮请求未能回填 `reasoning_content`，上游 API 返回 400 `10305`（"The reasoning_content in the thinking mode must be passed back to the API."）。

## [0.0.5] - 2026-07-14

### Added
- 思考模式兼容：缓存流式/非流式响应中的 `reasoning_content`，在后续工具调用请求中自动回填
- 上游映射自动恢复机制：从 `.bak` 备份、扩展 storage、本地历史记录中恢复丢失的上游映射
- `copilotRetryProxy.openConfig` 命令：在编辑器中打开上游配置文件

### Changed
- 改进了流首帧嗅探逻辑，细化可重试错误的判定条件
- HTTP 连接池管理，提升代理转发性能
- 上游映射落盘使用原子写入（临时文件 + rename），防止断电损坏
- 改写 `chatLanguageModels.json` 前强制确保上游映射已安全落盘

### Fixed
- 修正未注册 `openConfig` 命令的问题

## [0.0.4] - 2026-07-10

### Added
- 指数退避 + 抖动重试策略，尊重 `retry-after` / `retry-after-ms` 头
- 流式响应首帧错误嗅探，流开始后不中途重连
- 状态栏可视化 ON/OFF，配置变更自动重启
- 自动探测多平台 `chatLanguageModels.json` 路径

### Changed
- 改写 `chatLanguageModels.json` 前创建 `.bak` 备份

## [0.0.3] - 2026-07-08

### Added
- 支持 Windows / macOS / Linux 三平台自动路径探测
- 命令面板集成：启动/停止/重启/查看状态/查看日志

## [0.0.2] - 2026-07-05

### Added
- 本地 HTTP 代理，按路径前缀转发到真实上游
- 自动改写 `chatLanguageModels.json` 劫持第三方模型流量
- 429 / 5xx / 11210 错误自动重试

## [0.0.1] - 2026-07-01

- 初始版本
