import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { SessionPidFile, TokenUsage } from '../types';

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const STATUS_IDLE_MS = 5_000;

export interface TokenUpdateEvent {
  sessionId: string;
  delta: TokenUsage;
}

export class SessionWatcher implements vscode.Disposable {
  private readonly _onSessionStarted = new vscode.EventEmitter<SessionPidFile>();
  private readonly _onSessionEnded = new vscode.EventEmitter<number>();
  private readonly _onSessionRenamed = new vscode.EventEmitter<{ sessionId: string; newName: string }>();
  private readonly _onSessionActivity = new vscode.EventEmitter<string>();
  private readonly _onSessionIdle = new vscode.EventEmitter<string>();
  private readonly _onSessionTokenUpdate = new vscode.EventEmitter<TokenUpdateEvent>();

  readonly onSessionStarted = this._onSessionStarted.event;
  readonly onSessionEnded = this._onSessionEnded.event;
  readonly onSessionRenamed = this._onSessionRenamed.event;
  readonly onSessionActivity = this._onSessionActivity.event;
  readonly onSessionIdle = this._onSessionIdle.event;
  readonly onSessionTokenUpdate = this._onSessionTokenUpdate.event;

  private dirWatcher: fs.FSWatcher | null = null;
  private jsonlWatchers = new Map<string, { watcher: fs.FSWatcher; offset: number; idleTimer: ReturnType<typeof setTimeout> | null }>();
  private knownPids = new Set<number>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.scanExistingPidFiles();
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      this.dirWatcher = fs.watch(SESSIONS_DIR, (_, filename) => {
        if (!filename?.endsWith('.json')) { return; }
        this.debouncedScan();
      });
    } catch { /* sessions dir may not exist yet */ }
  }

  watchJsonlFile(sessionId: string, jsonlPath: string): void {
    if (this.jsonlWatchers.has(sessionId)) { return; }
    try {
      const stats = fs.statSync(jsonlPath);
      const offset = stats.size;
      const watcher = fs.watch(jsonlPath, () => {
        this.handleJsonlChange(sessionId, jsonlPath);
      });
      this.jsonlWatchers.set(sessionId, { watcher, offset, idleTimer: null });
    } catch { /* file may not exist yet */ }
  }

  unwatchJsonlFile(sessionId: string): void {
    const entry = this.jsonlWatchers.get(sessionId);
    if (entry) {
      entry.watcher.close();
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); }
      this.jsonlWatchers.delete(sessionId);
    }
  }

  private handleJsonlChange(sessionId: string, jsonlPath: string): void {
    const entry = this.jsonlWatchers.get(sessionId);
    if (!entry) { return; }

    this._onSessionActivity.fire(sessionId);

    if (entry.idleTimer) { clearTimeout(entry.idleTimer); }
    entry.idleTimer = setTimeout(() => {
      this._onSessionIdle.fire(sessionId);
    }, STATUS_IDLE_MS);

    this.checkJsonlAppend(sessionId, jsonlPath, entry);
  }

  private checkJsonlAppend(sessionId: string, jsonlPath: string, entry: { offset: number }): void {
    try {
      const stats = fs.statSync(jsonlPath);
      if (stats.size <= entry.offset) { return; }

      const fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(stats.size - entry.offset);
      fs.readSync(fd, buf, 0, buf.length, entry.offset);
      fs.closeSync(fd);
      entry.offset = stats.size;

      const newLines = buf.toString('utf-8').split('\n');
      for (const line of newLines) {
        if (!line.trim()) { continue; }
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'custom-title' && obj.customTitle) {
            this._onSessionRenamed.fire({ sessionId, newName: obj.customTitle });
          } else if (obj.type === 'agent-name' && obj.agentName) {
            this._onSessionRenamed.fire({ sessionId, newName: obj.agentName });
          }

          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            this._onSessionTokenUpdate.fire({
              sessionId,
              delta: {
                inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0),
                outputTokens: u.output_tokens || 0,
                cacheReadTokens: u.cache_read_input_tokens || 0,
                cacheCreateTokens: u.cache_creation_input_tokens || 0,
              },
            });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* file may be locked */ }
  }

  private debouncedScan(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => this.scanExistingPidFiles(), 100);
  }

  private scanExistingPidFiles(): void {
    let files: string[];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    } catch { return; }

    const currentPids = new Set<number>();

    for (const file of files) {
      const pid = parseInt(path.basename(file, '.json'), 10);
      if (isNaN(pid)) { continue; }
      currentPids.add(pid);

      if (!this.knownPids.has(pid)) {
        try {
          const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
          const pidFile: SessionPidFile = JSON.parse(raw);
          this._onSessionStarted.fire(pidFile);
        } catch { continue; }
      }
    }

    for (const oldPid of this.knownPids) {
      if (!currentPids.has(oldPid)) {
        this._onSessionEnded.fire(oldPid);
      }
    }

    this.knownPids = currentPids;
  }

  getActivePidFiles(): SessionPidFile[] {
    const results: SessionPidFile[] = [];
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
          results.push(JSON.parse(raw));
        } catch { continue; }
      }
    } catch { /* no sessions dir */ }
    return results;
  }

  dispose(): void {
    this.dirWatcher?.close();
    for (const [, entry] of this.jsonlWatchers) {
      entry.watcher.close();
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); }
    }
    this.jsonlWatchers.clear();
    this._onSessionStarted.dispose();
    this._onSessionEnded.dispose();
    this._onSessionRenamed.dispose();
    this._onSessionActivity.dispose();
    this._onSessionIdle.dispose();
    this._onSessionTokenUpdate.dispose();
  }
}
