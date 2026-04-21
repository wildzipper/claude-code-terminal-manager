import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { PreviousSession, SessionsIndex, TokenUsage } from '../types';
import { decodeProjectPath } from '../utils/pathEncoder';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

interface JsonlNames {
  customTitle?: string;
  agentName?: string;
  slug?: string;
}

export class SessionStorage {
  private cache: PreviousSession[] | null = null;

  invalidateCache(): void {
    this.cache = null;
  }

  async loadPreviousSessions(): Promise<PreviousSession[]> {
    if (this.cache) { return this.cache; }

    const sessions: PreviousSession[] = [];
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(PROJECTS_DIR).filter(name => {
        const fullPath = path.join(PROJECTS_DIR, name);
        return fs.statSync(fullPath).isDirectory();
      });
    } catch {
      return [];
    }

    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir);
      const projectPath = this.resolveProjectPath(dir, dirPath);
      const indexMetadata = this.loadIndexMetadata(dirPath);

      let jsonlFiles: string[];
      try {
        jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of jsonlFiles) {
        const sessionId = path.basename(file, '.jsonl');
        const jsonlPath = path.join(dirPath, file);

        let stats: fs.Stats;
        try { stats = fs.statSync(jsonlPath); } catch { continue; }

        const indexEntry = indexMetadata.get(sessionId);
        const scanResult = await this.scanJsonlFull(jsonlPath);
        const displayName = scanResult.names.customTitle
          || scanResult.names.agentName
          || scanResult.names.slug
          || this.truncate(indexEntry?.firstPrompt || scanResult.firstPrompt || '', 50);
        const firstLineMetadata = scanResult;

        const resolvedPath = scanResult.cwd || projectPath;

        sessions.push({
          sessionId,
          projectPath: resolvedPath,
          displayName,
          firstPrompt: indexEntry?.firstPrompt || scanResult.firstPrompt || '',
          created: indexEntry?.created || scanResult.timestamp || stats.birthtime.toISOString(),
          modified: indexEntry?.modified || stats.mtime.toISOString(),
          messageCount: indexEntry?.messageCount || scanResult.messageCount,
          gitBranch: indexEntry?.gitBranch || scanResult.gitBranch || '',
          jsonlPath,
          tokenUsage: scanResult.tokenUsage,
        });
      }
    }

    sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    this.cache = sessions;
    return sessions;
  }

  async resolveDisplayName(jsonlPath: string, fallback: string): Promise<string> {
    try {
      const names = await this.scanJsonlForNames(jsonlPath);
      return names.customTitle || names.agentName || names.slug || this.truncate(fallback, 50);
    } catch {
      return this.truncate(fallback, 50);
    }
  }

  findJsonlForSession(sessionId: string): string | undefined {
    try {
      const projectDirs = fs.readdirSync(PROJECTS_DIR);
      for (const dir of projectDirs) {
        const jsonlPath = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
          if (fs.statSync(jsonlPath).isFile()) { return jsonlPath; }
        } catch { continue; }
      }
    } catch { /* projects dir may not exist */ }
    return undefined;
  }

  scanTokenUsage(jsonlPath: string): Promise<TokenUsage> {
    return new Promise((resolve) => {
      const usage: TokenUsage = { contextTokens: 0, cumulativeOutput: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
      let stream: fs.ReadStream;
      try {
        stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
      } catch { resolve(usage); return; }

      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            usage.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            usage.cumulativeOutput += u.output_tokens || 0;
            usage.cacheReadTokens = u.cache_read_input_tokens || 0;
            usage.cacheCreateTokens = u.cache_creation_input_tokens || 0;
          }
        } catch { /* skip */ }
      });
      rl.on('close', () => resolve(usage));
      rl.on('error', () => resolve(usage));
    });
  }

  private resolveProjectPath(dirName: string, dirPath: string): string {
    try {
      const indexPath = path.join(dirPath, 'sessions-index.json');
      const raw = fs.readFileSync(indexPath, 'utf-8');
      const index: SessionsIndex = JSON.parse(raw);
      if (index.originalPath) { return index.originalPath; }
    } catch { /* no index */ }
    return decodeProjectPath(dirName);
  }

  private loadIndexMetadata(dirPath: string): Map<string, { firstPrompt: string; created: string; modified: string; messageCount: number; gitBranch: string }> {
    const map = new Map<string, { firstPrompt: string; created: string; modified: string; messageCount: number; gitBranch: string }>();
    try {
      const raw = fs.readFileSync(path.join(dirPath, 'sessions-index.json'), 'utf-8');
      const index: SessionsIndex = JSON.parse(raw);
      for (const entry of index.entries) {
        map.set(entry.sessionId, {
          firstPrompt: entry.firstPrompt,
          created: entry.created,
          modified: entry.modified,
          messageCount: entry.messageCount,
          gitBranch: entry.gitBranch,
        });
      }
    } catch { /* index doesn't exist for most projects */ }
    return map;
  }

  private scanJsonlFull(jsonlPath: string): Promise<{
    names: JsonlNames;
    tokenUsage: TokenUsage;
    firstPrompt?: string;
    timestamp?: string;
    gitBranch?: string;
    cwd?: string;
    messageCount: number;
  }> {
    return new Promise((resolve) => {
      const names: JsonlNames = {};
      const tokenUsage: TokenUsage = { contextTokens: 0, cumulativeOutput: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
      let firstPrompt: string | undefined;
      let timestamp: string | undefined;
      let gitBranch: string | undefined;
      let cwd: string | undefined;
      let messageCount = 0;

      let stream: fs.ReadStream;
      try {
        stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
      } catch { resolve({ names, tokenUsage, messageCount: 0 }); return; }

      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'custom-title' && obj.customTitle) {
            names.customTitle = obj.customTitle;
          } else if (obj.type === 'agent-name' && obj.agentName) {
            names.agentName = obj.agentName;
          }
          if (obj.slug && !names.slug) { names.slug = obj.slug; }
          if (!cwd && obj.cwd) { cwd = obj.cwd; }
          if (obj.type === 'user') {
            messageCount++;
            if (!firstPrompt && obj.message?.content) {
              const content = typeof obj.message.content === 'string'
                ? obj.message.content : JSON.stringify(obj.message.content);
              firstPrompt = content.substring(0, 100);
              timestamp = obj.timestamp;
              gitBranch = obj.gitBranch;
            }
          }
          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            tokenUsage.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            tokenUsage.cumulativeOutput += u.output_tokens || 0;
            tokenUsage.cacheReadTokens = u.cache_read_input_tokens || 0;
            tokenUsage.cacheCreateTokens = u.cache_creation_input_tokens || 0;
          }
        } catch { /* skip */ }
      });
      rl.on('close', () => resolve({ names, tokenUsage, firstPrompt, timestamp, gitBranch, cwd, messageCount }));
      rl.on('error', () => resolve({ names, tokenUsage, messageCount: 0 }));
    });
  }

  private scanJsonlForNames(jsonlPath: string): Promise<JsonlNames> {
    return new Promise((resolve) => {
      const result: JsonlNames = {};
      let stream: fs.ReadStream;
      try {
        stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
      } catch { resolve(result); return; }

      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'custom-title' && obj.customTitle) {
            result.customTitle = obj.customTitle;
          } else if (obj.type === 'agent-name' && obj.agentName) {
            result.agentName = obj.agentName;
          } else if (obj.slug && !result.slug) {
            result.slug = obj.slug;
          }
        } catch { /* skip malformed lines */ }
      });
      rl.on('close', () => resolve(result));
      rl.on('error', () => resolve(result));
    });
  }

  private truncate(str: string, maxLen: number): string {
    if (!str) { return '(unnamed)'; }
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
  }
}
