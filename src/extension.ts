import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RetryProxy, ProxyConfig } from './proxy';
import {
  ChatLanguageModelEntry,
  hostnameToPrefix,
  isProxyUrl,
  proxyPrefixFromUrl,
  recoverUpstreamsFromLocalData,
} from './upstreamDiscovery';

let proxy: RetryProxy | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let globalStoragePath: string;
let chatModelsPath: string | undefined;

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

let isRewriting = false;

function syncChatModelsToProxy(): { upstreams: Record<string, string>; rewritten: boolean } {
  if (isRewriting) {
    return { upstreams: loadUpstreamsFromFile(), rewritten: false };
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
  const recovered = recoverUpstreamsFromLocalData(chatModelsPath, entries, result);
  for (const [prefix, base] of Object.entries(recovered.upstreams)) {
    if (!result[prefix]) {
      result[prefix] = base;
    }
  }
  if (recovered.sources.length > 0) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [INFO] 已自动恢复上游映射: ${Object.keys(recovered.upstreams).join(', ')}（来源: ${recovered.sources.join(', ')}）`
    );
  }
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
        const prefix = proxyPrefixFromUrl(model.url);
        if (prefix && result[prefix] === undefined) continue;
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

  // Never replace persistent routing with an empty object. A publisher/ID
  // migration or a temporarily unavailable model file must remain recoverable.
  const mappingPersisted =
    Object.keys(finalUpstreams).length > 0 && saveUpstreamsToFile(finalUpstreams);

  if (rewritten) {
    if (!mappingPersisted) {
      outputChannel.appendLine(
        `[${new Date().toISOString()}] [ERROR] 上游映射未能安全落盘，已取消改写 chatLanguageModels.json`
      );
      return { upstreams: finalUpstreams, rewritten: false };
    }
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

function saveUpstreamsToFile(upstreams: Record<string, string>): boolean {
  const configPath = getUpstreamsConfigPath();
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const merged: Record<string, string> = {};
    if (fs.existsSync(configPath)) {
      const existing: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error('现有 upstreams.json 不是有效对象，拒绝覆盖');
      }
      for (const [prefix, base] of Object.entries(existing)) {
        if (typeof base === 'string' && base.trim()) {
          merged[prefix] = base;
        }
      }
    }
    Object.assign(merged, upstreams);
    fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tempPath, configPath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup failures; the uniquely named temp file is harmless.
    }
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] 写入 upstreams.json 失败: ${(err as Error).message}`
    );
    return false;
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

async function openConfig(): Promise<void> {
  const configPath = getUpstreamsConfigPath();
  if (!fs.existsSync(configPath)) {
    const empty = '{}';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, empty, 'utf8');
  }
  const doc = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(doc);
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
    vscode.commands.registerCommand('copilotRetryProxy.showLog', showLog),
    vscode.commands.registerCommand('copilotRetryProxy.openConfig', openConfig)
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
        const enabled = vscode.workspace
          .getConfiguration('copilotRetryProxy')
          .get<boolean>('enabled', true);
        if ((proxy && proxy.isRunning()) || enabled) {
          restartProxy();
        }
      }, 1000);
    });
    context.subscriptions.push(watcher);
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
