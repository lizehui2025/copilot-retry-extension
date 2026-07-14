# Copilot Retry Proxy

本地重试代理 VS Code 扩展，自动重试第三方 Chat 模型 API 的限流错误（429 / 5xx / 11210）。

## 功能

- 本地 HTTP 代理监听 `127.0.0.1:8787`，按路径前缀转发到真实上游
- 指数退避 + 抖动重试策略，尊重 `retry-after` / `retry-after-ms` 头
- 流式响应首帧嗅探：首帧错误可重试，流开始后不中途重连
- 思考模式兼容：缓存响应中的 `reasoning_content`，并在后续工具调用/对话请求缺失时自动回填
- 自动改写 `chatLanguageModels.json`，劫持第三方模型流量到本地代理
- 改写前在原文件同目录创建 `.bak` 备份
- 状态栏可视化 ON/OFF，配置变更自动重启

思考内容仅保存在扩展进程内存中，按上游、模型和 API 凭据隔离；不会写入磁盘或输出日志，并会在代理停止时清空。

## 配置项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `copilotRetryProxy.enabled` | `true` | 启动时自动启动代理 |
| `copilotRetryProxy.port` | `8787` | 监听端口 |
| `copilotRetryProxy.maxRetries` | `5` | 最大重试次数 |
| `copilotRetryProxy.initialBackoffMs` | `1000` | 初始退避（毫秒） |
| `copilotRetryProxy.backoffMultiplier` | `2` | 退避倍数 |
| `copilotRetryProxy.maxBackoffMs` | `30000` | 最大退避（毫秒） |
| `copilotRetryProxy.upstreams` | `{}` | 手动上游映射（覆盖自动读取） |

## 命令

- `Copilot Retry Proxy: 启动代理`
- `Copilot Retry Proxy: 停止代理`
- `Copilot Retry Proxy: 重启代理`
- `Copilot Retry Proxy: 查看状态`
- `Copilot Retry Proxy: 查看日志`

## 平台支持

自动探测 `chatLanguageModels.json` 位置，覆盖：
- Linux：`~/.config/Code/User`、`Code - Insiders`、`VSCodium`、`Cursor`
- macOS：`~/Library/Application Support/{...}/User`
- Windows：`%APPDATA%\{...}\User`

## 开发

```bash
npm install
npm run compile      # 编译 TS → out/
npm run watch        # 监听模式
npm test             # 运行 SSE 与 reasoning_content 回归测试
npm run lint         # TypeScript 类型检查
```

## 还原 chatLanguageModels.json

代理会在原文件同目录创建 `chatLanguageModels.json.bak`，可直接用该文件还原。
