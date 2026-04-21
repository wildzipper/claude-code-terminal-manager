import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { ActiveSession, SessionPidFile, TokenUsage } from '../types';
import { SessionWatcher, TokenUpdateEvent } from './sessionWatcher';
import { SessionStorage } from './sessionStorage';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export class TerminalTracker implements vscode.Disposable {
  private readonly _onSessionsChanged = new vscode.EventEmitter<void>();
  readonly onSessionsChanged = this._onSessionsChanged.event;

  private sessions = new Map<string, ActiveSession>();
  private terminalPids = new Map<vscode.Terminal, number>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private sessionWatcher: SessionWatcher,
    private sessionStorage: SessionStorage,
  ) {}

  start(): void {
    for (const terminal of vscode.window.terminals) {
      this.trackTerminalPid(terminal);
    }

    this.disposables.push(
      vscode.window.onDidOpenTerminal(t => this.trackTerminalPid(t)),
      vscode.window.onDidCloseTerminal(t => this.handleTerminalClosed(t)),
      this.sessionWatcher.onSessionStarted(pf => this.handleSessionStarted(pf)),
      this.sessionWatcher.onSessionEnded(pid => this.handleSessionEnded(pid)),
      this.sessionWatcher.onSessionRenamed(e => this.handleSessionRenamed(e)),
      this.sessionWatcher.onSessionActivity(id => this.updateStatus(id, 'working')),
      this.sessionWatcher.onSessionIdle(id => this.updateStatus(id, 'ready')),
      this.sessionWatcher.onSessionTokenUpdate(e => this.handleTokenUpdate(e)),
    );

    setTimeout(() => this.matchExistingSessions(), 1000);
  }

  getActiveSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionBySessionId(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateStatus(sessionId: string, status: 'ready' | 'working' | 'unknown'): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status !== status) {
      session.status = status;
      this._onSessionsChanged.fire();
    }
  }

  getSessionForTerminal(terminal: vscode.Terminal): ActiveSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.terminal === terminal) { return session; }
    }
    return undefined;
  }

  private trackTerminalPid(terminal: vscode.Terminal): void {
    terminal.processId.then(pid => {
      if (pid !== undefined) {
        this.terminalPids.set(terminal, pid);
      }
    });
  }

  private async handleSessionStarted(pidFile: SessionPidFile): Promise<void> {
    if (this.sessions.has(pidFile.sessionId)) { return; }

    const terminal = await this.findTerminalForClaudePid(pidFile.pid);
    if (!terminal) { return; }

    const jsonlPath = this.findJsonlPath(pidFile);
    const displayName = await this.resolveSessionName(pidFile, jsonlPath);

    let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    if (jsonlPath) {
      this.sessionWatcher.watchJsonlFile(pidFile.sessionId, jsonlPath);
      tokenUsage = await this.sessionStorage.scanTokenUsage(jsonlPath);
    }

    this.sessions.set(pidFile.sessionId, {
      sessionId: pidFile.sessionId,
      terminal,
      cwd: pidFile.cwd,
      displayName,
      status: 'ready',
      pid: pidFile.pid,
      startedAt: pidFile.startedAt,
      version: pidFile.version,
      jsonlPath,
      tokenUsage,
    });
    this._onSessionsChanged.fire();
  }

  private handleSessionEnded(pid: number): void {
    for (const [id, session] of this.sessions) {
      if (session.pid === pid) {
        this.sessionWatcher.unwatchJsonlFile(id);
        this.sessions.delete(id);
        this._onSessionsChanged.fire();
        return;
      }
    }
  }

  private handleTerminalClosed(terminal: vscode.Terminal): void {
    this.terminalPids.delete(terminal);
    for (const [id, session] of this.sessions) {
      if (session.terminal === terminal) {
        this.sessionWatcher.unwatchJsonlFile(id);
        this.sessions.delete(id);
        this._onSessionsChanged.fire();
        return;
      }
    }
  }

  private handleSessionRenamed(event: { sessionId: string; newName: string }): void {
    const session = this.sessions.get(event.sessionId);
    if (session) {
      session.displayName = event.newName;
      this._onSessionsChanged.fire();
    }
  }

  private handleTokenUpdate(event: TokenUpdateEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (session) {
      session.tokenUsage.inputTokens += event.delta.inputTokens;
      session.tokenUsage.outputTokens += event.delta.outputTokens;
      session.tokenUsage.cacheReadTokens += event.delta.cacheReadTokens;
      session.tokenUsage.cacheCreateTokens += event.delta.cacheCreateTokens;
      this._onSessionsChanged.fire();
    }
  }

  private async findTerminalForClaudePid(claudePid: number): Promise<vscode.Terminal | undefined> {
    const parentPid = await this.getParentPid(claudePid);
    if (parentPid === undefined) { return undefined; }

    for (const [terminal, termPid] of this.terminalPids) {
      if (termPid === parentPid) { return terminal; }
      const termChildPids = await this.getChildPids(termPid);
      if (termChildPids.some(cp => cp === parentPid || cp === claudePid)) {
        return terminal;
      }
    }
    return undefined;
  }

  private getParentPid(pid: number): Promise<number | undefined> {
    return new Promise(resolve => {
      cp.exec(
        `wmic process where "ProcessId=${pid}" get ParentProcessId /format:value`,
        { timeout: 3000 },
        (err, stdout) => {
          if (err) { resolve(undefined); return; }
          const match = stdout.match(/ParentProcessId=(\d+)/);
          resolve(match ? parseInt(match[1], 10) : undefined);
        },
      );
    });
  }

  private getChildPids(pid: number): Promise<number[]> {
    return new Promise(resolve => {
      cp.exec(
        `wmic process where "ParentProcessId=${pid}" get ProcessId /format:value`,
        { timeout: 3000 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          const pids = [...stdout.matchAll(/ProcessId=(\d+)/g)].map(m => parseInt(m[1], 10));
          resolve(pids);
        },
      );
    });
  }

  private async matchExistingSessions(): Promise<void> {
    const pidFiles = this.sessionWatcher.getActivePidFiles();
    for (const pf of pidFiles) {
      await this.handleSessionStarted(pf);
    }
  }

  private async resolveSessionName(pidFile: SessionPidFile, jsonlPath?: string): Promise<string> {
    // Coalesce: customTitle > agentName > pidFile.name > slug > firstPrompt > UUID
    if (jsonlPath) {
      try {
        const name = await this.sessionStorage.resolveDisplayName(jsonlPath, '');
        if (name && name !== '(unnamed)') { return name; }
      } catch { /* fall through */ }
    }
    if (pidFile.name) { return pidFile.name; }
    return pidFile.sessionId.substring(0, 8);
  }

  private findJsonlPath(pidFile: SessionPidFile): string | undefined {
    const found = this.sessionStorage.findJsonlForSession(pidFile.sessionId);
    if (found) { return found; }

    const cwdNormalized = pidFile.cwd.replace(/\//g, '\\');
    const encoded = cwdNormalized
      .replace(/:\\/g, '--')
      .replace(/\\/g, '-')
      .replace(/\./g, '-');

    const candidates = [encoded, encoded.toLowerCase(), encoded.toUpperCase()];
    if (encoded[0]) {
      candidates.push(
        encoded[0].toLowerCase() + encoded.substring(1),
        encoded[0].toUpperCase() + encoded.substring(1),
      );
    }

    for (const candidate of candidates) {
      const jsonlPath = path.join(PROJECTS_DIR, candidate, `${pidFile.sessionId}.jsonl`);
      try {
        if (fs.statSync(jsonlPath).isFile()) { return jsonlPath; }
      } catch { continue; }
    }
    return undefined;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.sessions.clear();
    this.terminalPids.clear();
    this._onSessionsChanged.dispose();
  }
}
