import * as fs from 'fs';
import * as path from 'path';

export type ApiType = 'chat-completions';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type ReasoningEffortFormat = 'chat-completions';

export interface ChatModelSettings {
  reasoningEffort?: ReasoningEffort;
  [key: string]: unknown;
}

export interface ChatModelDefinition {
  id?: string;
  name?: string;
  url?: string;
  stream?: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  thinking?: boolean;
  supportsReasoningEffort?: ReasoningEffort[];
  reasoningEffortFormat?: ReasoningEffortFormat;
  [key: string]: unknown;
}

export interface ChatLanguageModelEntry {
  name?: string;
  vendor?: string;
  apiType?: ApiType;
  apiKey?: string;
  models?: ChatModelDefinition[];
  stream?: boolean;
  settings?: Record<string, ChatModelSettings>;
  [key: string]: unknown;
}

export interface RecoveryResult {
  upstreams: Record<string, string>;
  sources: string[];
}

export function hostnameToPrefix(hostname: string): string {
  const parts = hostname.split('.');
  const meaningful = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return '/' + meaningful.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function proxyPrefixFromUrl(url: string): string | undefined {
  if (!isProxyUrl(url)) {
    return undefined;
  }
  try {
    const match = new URL(url).pathname.match(/^\/([^/]+)/);
    return match ? `/${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

export function realUpstreamsFromEntries(
  entries: ChatLanguageModelEntry[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    for (const model of entry.models || []) {
      if (!model.url || isProxyUrl(model.url)) {
        continue;
      }
      try {
        const url = new URL(model.url);
        result[hostnameToPrefix(url.hostname)] = `${url.protocol}//${url.host}`;
      } catch {
        // Ignore malformed model URLs.
      }
    }
  }
  return result;
}

function proxyPrefixesFromEntries(entries: ChatLanguageModelEntry[]): Set<string> {
  const result = new Set<string>();
  for (const entry of entries) {
    for (const model of entry.models || []) {
      if (!model.url) {
        continue;
      }
      const prefix = proxyPrefixFromUrl(model.url);
      if (prefix) {
        result.add(prefix);
      }
    }
  }
  return result;
}

function readModelEntries(filename: string): ChatLanguageModelEntry[] | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return Array.isArray(parsed) ? (parsed as ChatLanguageModelEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

function mergeNeeded(
  target: Record<string, string>,
  candidates: Record<string, string>,
  needed: Set<string>
): boolean {
  let changed = false;
  for (const prefix of needed) {
    if (!target[prefix] && candidates[prefix]) {
      target[prefix] = candidates[prefix];
      changed = true;
    }
  }
  return changed;
}

function isComplete(upstreams: Record<string, string>, needed: Set<string>): boolean {
  return [...needed].every((prefix) => Boolean(upstreams[prefix]));
}

function recoverFromModelFile(
  filename: string,
  target: Record<string, string>,
  needed: Set<string>
): boolean {
  const entries = readModelEntries(filename);
  return entries
    ? mergeNeeded(target, realUpstreamsFromEntries(entries), needed)
    : false;
}

function recoverFromExtensionStorage(
  userDir: string,
  target: Record<string, string>,
  needed: Set<string>,
  sources: string[]
): void {
  const storageRoot = path.join(userDir, 'globalStorage');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(storageRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || !dir.name.toLowerCase().endsWith('.copilot-retry-proxy')) {
      continue;
    }
    const filename = path.join(storageRoot, dir.name, 'upstreams.json');
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidates: Record<string, string> = {};
        for (const [prefix, base] of Object.entries(parsed)) {
          if (typeof base === 'string' && base) {
            candidates[prefix] = base;
          }
        }
        if (mergeNeeded(target, candidates, needed)) {
          sources.push(filename);
        }
      }
    } catch {
      // Ignore missing, malformed, or inaccessible legacy storage.
    }
  }
}

interface HistoryEntry {
  id?: string;
  timestamp?: number;
}

interface HistoryIndex {
  resource?: string;
  entries?: HistoryEntry[];
}

function recoverFromHistory(
  userDir: string,
  chatModelsPath: string,
  target: Record<string, string>,
  needed: Set<string>,
  sources: string[]
): void {
  const historyRoot = path.join(userDir, 'History');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(historyRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const snapshots: Array<{ filename: string; timestamp: number }> = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const historyDir = path.join(historyRoot, dir.name);
    try {
      const index = JSON.parse(
        fs.readFileSync(path.join(historyDir, 'entries.json'), 'utf8')
      ) as HistoryIndex;
      if (!index.resource || !historyResourceMatches(index.resource, chatModelsPath)) {
        continue;
      }
      for (const entry of index.entries || []) {
        if (entry.id) {
          snapshots.push({
            filename: path.join(historyDir, entry.id),
            timestamp: entry.timestamp || 0,
          });
        }
      }
    } catch {
      // Ignore unrelated or malformed history indexes.
    }
  }

  snapshots.sort((a, b) => b.timestamp - a.timestamp);
  for (const snapshot of snapshots) {
    if (recoverFromModelFile(snapshot.filename, target, needed)) {
      sources.push(snapshot.filename);
    }
    if (isComplete(target, needed)) {
      break;
    }
  }
}

function historyResourceMatches(resource: string, chatModelsPath: string): boolean {
  try {
    let resourcePath = decodeURIComponent(new URL(resource).pathname);
    if (process.platform === 'win32' && /^\/[a-zA-Z]:\//.test(resourcePath)) {
      resourcePath = resourcePath.slice(1);
    }
    return path.resolve(resourcePath) === path.resolve(chatModelsPath);
  } catch {
    return false;
  }
}

export function recoverUpstreamsFromLocalData(
  chatModelsPath: string,
  currentEntries: ChatLanguageModelEntry[],
  existingUpstreams: Record<string, string> = {}
): RecoveryResult {
  const needed = new Set(
    [...proxyPrefixesFromEntries(currentEntries)].filter(
      (prefix) => !existingUpstreams[prefix]
    )
  );
  const upstreams: Record<string, string> = {};
  const sources: string[] = [];
  if (needed.size === 0) {
    return { upstreams, sources };
  }

  const backupPath = `${chatModelsPath}.bak`;
  if (recoverFromModelFile(backupPath, upstreams, needed)) {
    sources.push(backupPath);
  }

  const userDir = path.dirname(chatModelsPath);
  if (!isComplete(upstreams, needed)) {
    recoverFromExtensionStorage(userDir, upstreams, needed, sources);
  }
  if (!isComplete(upstreams, needed)) {
    recoverFromHistory(userDir, chatModelsPath, upstreams, needed, sources);
  }
  return { upstreams, sources };
}
