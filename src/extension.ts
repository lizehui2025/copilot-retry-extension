import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RetryProxy, ProxyConfig } from './proxy';

let proxy: RetryProxy | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let globalStoragePath: string;
let chatModelsPath: string | undefined;
let fileWatcher: vscode.FileSystemWatcher | null = null;

function getUpstreamsConfigPath(): string {
  return path.join(globalStoragePath, 'upstreams.json');
}

function candidateUserDirs(): string[] {
  const home = os.homedir();
  const platform = process.platform;
  const dirs: string[] = [];
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'Code', 'User'));
    dirs.push(path.join(appData, 'Code - Insiders', 'User'));
    dirs.push(path.join(appData, 'VSCodium', 'User'));
    dirs.push(path.join(appData, 'Cursor', 'User'));
  } else if (platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
    dirs.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'));
    dirs.push(path.join(home, 'Library', 'Application Support', 'VSCodium', 'User'));
    dirs.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User'));
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    dirs.push(path.join(configHome, 'Code', 'User'));
    dirs.push(path.join(configHome, 'Code - Insiders', 'User'));
    dirs.push(path.join(configHome, 'VSCodium', 'User'));
    dirs.push(path.join(configHome, 'Cursor', 'User'));
  }
  return dirs;
}

function getChatLanguageModelsPath(): string | undefined {
  const filename = 'chatLanguageModels.json';
  for (const dir of candidateUserDirs()) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

interface ChatLanguageModelEntry {
  name?: string;
  models?: Array<{ url?: string }>;
}

function hostnameToPrefix(hostname: string): string {
  const parts = hostname.split('.');
  const meaningful = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return '/' + meaningful.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

let isRewriting = false;

function syncChatModelsToProxy(): { upstreams: Record<string, string>; rewritten: boolean } {
  if (isRewriting) {
    return { upstreams: {}, rewritten: false };
  }
  const result: Record<string, string> = loadUpstreamsFromFile();
  if (!chatModelsPath || !fs.existsSync(chatModelsPath)) {
    return { upstreams: result, rewritten: false };
  }
  let content: string;
  try {
    content = fs.readFileSync(chatModelsPath, 'utf8');
  } catch (err) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] 读取 chatLanguageModels.json 失败: ${(err as Error).message}`
    );
    return { upstreams: result, rewritten: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] 解析 chatLanguageModels.json 失败: ${(err as Error).message}`
    );
    return { upstreams: result, rewritten: false };
  }
  if (!Array.isArray(parsed)) {
    return { upstreams: result, rewritten: false };
  }
  const entries = parsed as ChatLanguageModelEntry[];
  let rewritten = false;
  for (const entry of entries) {
    if (!entry.models || !Array.isArray(entry.models)) {
      continue;
    }
    for (const model of entry.models) {
      if (!model.url || typeof model.url !== 'string') {
        continue;
      }
      if (isProxyUrl(model.url)) {
        try {
          const proxyUrl = new URL(model.url);
          const prefix = '/' + (proxyUrl.pathname.match(/^\/([^/]+)/) || [])[1];
          if (prefix && result[prefix] === undefined) continue;
        } catch {
        }
        continue;
      }
      try {
        const realUrl = new URL(model.url);
        const prefix = hostnameToPrefix(realUrl.hostname);
        const base = `${realUrl.protocol}//${realUrl.host}`;
        result[prefix] = base;
        const proxyUrl = `http://127.0.0.1:${getProxyPort()}${prefix}${realUrl.pathname}`;
        if (model.url !== proxyUrl) {
          model.url = proxyUrl;
          rewritten = true;
        }
      } catch {
      }
    }
  }
  const finalUpstreams: Record<string, string> = {};
  for (const [prefix, base] of Object.entries(result)) {
    if (base) {
      finalUpstreams[prefix] = base;
    }
  }

  saveUpstreamsToFile(finalUpstreams);

  if (rewritten) {
    try {
      isRewriting = true;
      const backupPath = chatModelsPath + '.bak';
      fs.writeFileSync(backupPath, content, 'utf8');
      fs.writeFileSync(chatModelsPath, JSON.stringify(entries, null, 2), 'utf8');
      outputChannel.appendLine(
        `[${new Date().toISOString()}] [INFO] 已自动改写 chatLanguageModels.json 中的 URL 为代理地址（原文件备份于 ${backupPath}）`
      );
    } catch (err) {
      outputChannel.appendLine(
        `[${new Date().toISOString()}] [ERROR] 写入 chatLanguageModels.json 失败: ${(err as Error).message}`
      );
    } finally {
      isRewriting = false;
    }
  }
  return { upstreams: finalUpstreams, rewritten };
}

function saveUpstreamsToFile(upstreams: Record<string, string>): void {
  try {
    fs.writeFileSync(getUpstreamsConfigPath(), JSON.stringify(upstreams, null, 2), 'utf8');
  } catch (err) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] 写入 upstreams.json 失败: ${(err as Error).message}`
    );
  }
}

function getProxyPort(): number {
  return vscode.workspace.getConfiguration('copilotRetryProxy').get('port', 8787);
}

function loadUpstreamsFromFile(): Record<string, string> {
  const result: Record<string, string> = {};
  const configPath = getUpstreamsConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return result;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return result;
    }
    for (const [prefix, base] of Object.entries(parsed)) {
      if (typeof base === 'string' && base.trim()) {
        result[prefix] = base;
      }
    }
  } catch (err) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] 读取 upstreams.json 失败: ${(err as Error).message}`
    );
  }
  return result;
}

function getConfig(): ProxyConfig {
  const cfg = vscode.workspace.getConfiguration('copilotRetryProxy');
  const { upstreams } = syncChatModelsToProxy();
  const configured = cfg.get<Record<string, string>>('upstreams', {});
  return {
    port: cfg.get('port', 8787),
    maxRetries: cfg.get('maxRetries', 5),
    initialBackoffMs: cfg.get('initialBackoffMs', 1000),
    backoffMultiplier: cfg.get('backoffMultiplier', 2),
    maxBackoffMs: cfg.get('maxBackoffMs', 30000),
    upstreams: { ...upstreams, ...configured },
  };
}

function updateStatusBar(): void {
  if (proxy && proxy.isRunning()) {
    statusBarItem.text = '$(globe) Retry Proxy: ON';
    statusBarItem.tooltip = 'Copilot Retry Proxy 正在运行';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(circle-slash) Retry Proxy: OFF';
    statusBarItem.tooltip = 'Copilot Retry Proxy 已停止';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN] ' : '[INFO] ';
  outputChannel.appendLine(`${new Date().toISOString()} ${prefix} ${message}`);
}

async function startProxy(): Promise<void> {
  if (proxy && proxy.isRunning()) {
    vscode.window.showInformationMessage('Copilot Retry Proxy 已在运行中');
    return;
  }
  const config = getConfig();
  if (Object.keys(config.upstreams).length === 0) {
    vscode.window.showWarningMessage(
      'Copilot Retry Proxy: 未检测到上游 API。请在 chatLanguageModels.json 中配置真实 API 地址。'
    );
    return;
  }
  proxy = new RetryProxy(config, log);
  try {
    await proxy.start();
    updateStatusBar();
    vscode.window.showInformationMessage(
      `Copilot Retry Proxy 已启动 (端口 ${config.port})`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Copilot Retry Proxy 启动失败: ${(err as Error).message}`
    );
  }
}

async function stopProxy(): Promise<void> {
  if (!proxy) {
    vscode.window.showInformationMessage('Copilot Retry Proxy 未运行');
    return;
  }
  await proxy.stop();
  updateStatusBar();
  vscode.window.showInformationMessage('Copilot Retry Proxy 已停止');
}

async function restartProxy(): Promise<void> {
  if (proxy) {
    await proxy.stop();
  }
  const config = getConfig();
  if (Object.keys(config.upstreams).length === 0) {
    proxy = null;
    updateStatusBar();
    vscode.window.showWarningMessage(
      'Copilot Retry Proxy: 上游映射为空，代理未启动。请恢复真实 API URL 或配置 copilotRetryProxy.upstreams。'
    );
    return;
  }
  proxy = new RetryProxy(config, log);
  try {
    await proxy.start();
    updateStatusBar();
    vscode.window.showInformationMessage(
      `Copilot Retry Proxy 已重启 (端口 ${config.port})`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Copilot Retry Proxy 重启失败: ${(err as Error).message}`
    );
  }
}

function maskHost(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const maskedHost =
      host.length > 8 ? host.slice(0, 4) + '***' + host.slice(-4) : '***';
    return `${parsed.protocol}//${maskedHost}`;
  } catch {
    return '***';
  }
}

function showStatus(): void {
  if (!proxy || !proxy.isRunning()) {
    vscode.window.showInformationMessage('Copilot Retry Proxy: 未运行');
    return;
  }
  const config = proxy.getConfig();
  const lines = [
    `状态: 运行中`,
    `监听: http://127.0.0.1:${config.port}`,
    `最大重试: ${config.maxRetries} 次`,
    `退避: ${config.initialBackoffMs}ms × ${config.backoffMultiplier}^n (上限 ${config.maxBackoffMs}ms)`,
    `上游映射:`,
    ...Object.entries(config.upstreams).map(
      ([k, v]) => `  ${k}/* → ${maskHost(v)}/*`
    ),
  ];
  vscode.window.showInformationMessage(lines.join('\n'));
}

function showLog(): void {
  outputChannel.show();
  if (proxy) {
    for (const entry of proxy.getLogs()) {
      const prefix =
        entry.level === 'error' ? '[ERROR]' : entry.level === 'warn' ? '[WARN] ' : '[INFO] ';
      outputChannel.appendLine(`${entry.time} ${prefix} ${entry.message}`);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Copilot Retry Proxy');
  context.subscriptions.push(outputChannel);

  globalStoragePath = context.globalStorageUri.fsPath;
  if (!fs.existsSync(globalStoragePath)) {
    fs.mkdirSync(globalStoragePath, { recursive: true });
  }

  const detected = getChatLanguageModelsPath();
  if (detected) {
    chatModelsPath = detected;
  } else {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [WARN] 未找到 chatLanguageModels.json，请在 VS Code 中先配置一个 customendpoint 模型后重载`
    );
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'copilotRetryProxy.showStatus';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotRetryProxy.start', startProxy),
    vscode.commands.registerCommand('copilotRetryProxy.stop', stopProxy),
    vscode.commands.registerCommand('copilotRetryProxy.restart', restartProxy),
    vscode.commands.registerCommand('copilotRetryProxy.showStatus', showStatus),
    vscode.commands.registerCommand('copilotRetryProxy.showLog', showLog)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotRetryProxy')) {
        if (proxy && proxy.isRunning()) {
          log('info', '配置已变更，重启代理...');
          restartProxy();
        }
      }
    })
  );

  if (chatModelsPath && fs.existsSync(chatModelsPath)) {
    const watcher = vscode.workspace.createFileSystemWatcher(chatModelsPath);
    let debounceTimer: NodeJS.Timeout | null = null;
    watcher.onDidChange(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        log('info', '检测到 chatLanguageModels.json 变更，重新加载上游映射...');
        if (proxy && proxy.isRunning()) {
          restartProxy();
        }
      }, 1000);
    });
    context.subscriptions.push(watcher);
    fileWatcher = watcher;
  }

  statusBarItem.show();
  updateStatusBar();

  const autoStart = vscode.workspace
    .getConfiguration('copilotRetryProxy')
    .get<boolean>('enabled', true);
  if (autoStart) {
    startProxy();
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (proxy) {
    return proxy.stop();
  }
  return undefined;
}
