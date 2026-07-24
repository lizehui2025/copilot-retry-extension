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
let lastSyncResult: { upstreams: Record<string, string>; rewritten: boolean; timestamp: number } | null = null;
const SYNC_CACHE_TTL_MS = 5000; // Sync result cache TTL in ms

// Sync lock ensures the sync process is not executed concurrently
let syncLock = false;

function syncChatModelsToProxy(): { upstreams: Record<string, string>; rewritten: boolean } {
  // If sync is in progress, return cached result to avoid blocking
  if (syncLock) {
    if (lastSyncResult && Date.now() - lastSyncResult.timestamp < SYNC_CACHE_TTL_MS) {
      return { upstreams: lastSyncResult.upstreams, rewritten: false };
    }
    return { upstreams: loadUpstreamsFromFile(), rewritten: false };
  }
  
  if (isRewriting) {
    return { upstreams: loadUpstreamsFromFile(), rewritten: false };
  }
  
  syncLock = true;
  const result: Record<string, string> = loadUpstreamsFromFile();
  if (!chatModelsPath || !fs.existsSync(chatModelsPath)) {
    return { upstreams: result, rewritten: false };
  }
  let content: string;
  try {
    content = fs.readFileSync(chatModelsPath, 'utf8');
  } catch (err) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] Failed to read chatLanguageModels.json: ${(err as Error).message}`
    );
    return { upstreams: result, rewritten: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [ERROR] Failed to parse chatLanguageModels.json: ${(err as Error).message}`
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
      `[${new Date().toISOString()}] [INFO] Auto-recovered upstream mappings: ${Object.keys(recovered.upstreams).join(', ')} (sources: ${recovered.sources.join(', ')})`
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
        `[${new Date().toISOString()}] [ERROR] Upstream mapping failed to persist safely, aborting chatLanguageModels.json rewrite`
      );
      return { upstreams: finalUpstreams, rewritten: false };
    }
    try {
      isRewriting = true;
      const backupPath = chatModelsPath + '.bak';
      fs.writeFileSync(backupPath, content, 'utf8');
      fs.writeFileSync(chatModelsPath, JSON.stringify(entries, null, 2), 'utf8');
      outputChannel.appendLine(
        `[${new Date().toISOString()}] [INFO] Auto-rewrote URLs in chatLanguageModels.json to proxy addresses (original backed up at ${backupPath})`
      );
    } catch (err) {
      outputChannel.appendLine(
        `[${new Date().toISOString()}] [ERROR] Failed to write chatLanguageModels.json: ${(err as Error).message}`
      );
    } finally {
      isRewriting = false;
      syncLock = false;
    }
  }
  
  // Cache result
  lastSyncResult = {
    upstreams: finalUpstreams,
    rewritten,
    timestamp: Date.now()
  };
  
  syncLock = false;
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
        throw new Error('Existing upstreams.json is not a valid object, refusing to overwrite');
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
      `[${new Date().toISOString()}] [ERROR] Failed to write upstreams.json: ${(err as Error).message}`
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
      `[${new Date().toISOString()}] [ERROR] Failed to read upstreams.json: ${(err as Error).message}`
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
    sniffTimeoutMs: cfg.get('sniffTimeoutMs', 30000),  // First frame sniff timeout, default 30s
    upstreams: { ...upstreams, ...configured },
  };
}

function updateStatusBar(): void {
  if (proxy && proxy.isRunning()) {
    statusBarItem.text = '$(globe) Retry Proxy: ON';
    statusBarItem.tooltip = 'Copilot Retry Proxy is running';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(circle-slash) Retry Proxy: OFF';
    statusBarItem.tooltip = 'Copilot Retry Proxy has stopped';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN] ' : '[INFO] ';
  outputChannel.appendLine(`${new Date().toISOString()} ${prefix} ${message}`);
}

async function startProxy(): Promise<void> {
  if (proxy && proxy.isRunning()) {
    vscode.window.showInformationMessage('Copilot Retry Proxy is already running');
    return;
  }
  const config = getConfig();
  if (Object.keys(config.upstreams).length === 0) {
    vscode.window.showWarningMessage(
      'Copilot Retry Proxy: No upstream APIs detected. Please configure real API URLs in chatLanguageModels.json.'
    );
    return;
  }
  proxy = new RetryProxy(config, log);
  try {
    await proxy.start();
    updateStatusBar();
    vscode.window.showInformationMessage(
      `Copilot Retry Proxy started (port ${config.port})`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Copilot Retry Proxy failed to start: ${(err as Error).message}`
    );
  }
}

async function stopProxy(): Promise<void> {
  if (!proxy) {
    vscode.window.showInformationMessage('Copilot Retry Proxy is not running');
    return;
  }
  await proxy.stop();
  updateStatusBar();
  vscode.window.showInformationMessage('Copilot Retry Proxy has stopped');
}

async function restartProxy(): Promise<void> {
  const config = getConfig();
  if (Object.keys(config.upstreams).length === 0) {
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
    updateStatusBar();
    vscode.window.showWarningMessage(
      'Copilot Retry Proxy: Upstream mapping is empty, proxy not started. Please restore real API URLs or configure copilotRetryProxy.upstreams.'
    );
    return;
  }

  // If proxy is already running, try hot config update
  if (proxy && proxy.isRunning()) {
    // Check if port changed; if so, full restart is needed
    const currentConfig = proxy.getConfig();
    if (currentConfig.port === config.port) {
      // Port unchanged, try hot config update
      proxy.updateConfig(config);
      updateStatusBar();
      vscode.window.showInformationMessage(
        'Copilot Retry Proxy config hot-reloaded'
      );
      return;
    }
    // Port changed, need full restart
    await proxy.stop();
  }
  
  proxy = new RetryProxy(config, log);
  try {
    await proxy.start();
    updateStatusBar();
    vscode.window.showInformationMessage(
      `Copilot Retry Proxy started (port ${config.port})`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Copilot Retry Proxy failed to start: ${(err as Error).message}`
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
    vscode.window.showInformationMessage('Copilot Retry Proxy: Not running');
    return;
  }
  const config = proxy.getConfig();
  const lines = [
    `Status: Running`,
    `Listen: http://127.0.0.1:${config.port}`,
    `Max retries: ${config.maxRetries}`,
    `Backoff: ${config.initialBackoffMs}ms × ${config.backoffMultiplier}^n (cap ${config.maxBackoffMs}ms)`,
    `Upstream mapping:`,
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
      `[${new Date().toISOString()}] [WARN] chatLanguageModels.json not found. Please configure a custom endpoint model in VS Code and reload`
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
          log('info', 'Configuration changed, restarting proxy...');
          restartProxy().catch((err) => {
            log('error', `Config change restart failed: ${(err as Error).message}`);
          });
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
        log('info', 'chatLanguageModels.json changed, reloading upstream mapping...');
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
    const stopPromise = proxy.stop();
    // Ensure status bar reflects stopped state
    if (statusBarItem) {
      statusBarItem.text = '$(circle-slash) Retry Proxy: OFF';
      statusBarItem.tooltip = 'Copilot Retry Proxy has stopped';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [INFO] Extension deactivated, proxy closed`
    );
    return stopPromise;
  }
  return undefined;
}
