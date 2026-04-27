import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { ActiveSession, SessionPidFile, SessionStatus, sessionStatus, statusEquals, TokenUsage } from '../types';
import { SessionWatcher, StatusChangeEvent, TokenUpdateEvent } from './sessionWatcher';
import { SessionStorage } from './sessionStorage';
import { Logger } from './logger';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export class TerminalTracker implements vscode.Disposable {
  private readonly _onSessionsChanged = new vscode.EventEmitter<void>();
  readonly onSessionsChanged = this._onSessionsChanged.event;

  private sessions = new Map<string, ActiveSession>();
  private terminalPids = new Map<vscode.Terminal, number>();
  private disposables: vscode.Disposable[] = [];
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionWatcher: SessionWatcher,
    private sessionStorage: SessionStorage,
    private logger: Logger,
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
      this.sessionWatcher.onSessionStatusChanged(e => this.handleStatusChanged(e)),
      this.sessionWatcher.onSessionTokenUpdate(e => this.handleTokenUpdate(e)),
    );

    setTimeout(() => this.matchExistingSessions(), 1000);

    this.statusPollTimer = setInterval(() => this.pollSessionStatuses(), 5000);
  }

  getActiveSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionBySessionId(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
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
    this.logger.log('session', 'started', { sessionId: pidFile.sessionId, pid: pidFile.pid });

    const terminal = await this.findTerminalForClaudePid(pidFile.pid);
    if (!terminal) {
      this.logger.log('session', 'no terminal match', { sessionId: pidFile.sessionId, pid: pidFile.pid });
      return;
    }

    const jsonlPath = this.findJsonlPath(pidFile);
    this.logger.log('session', 'jsonl resolved', { sessionId: pidFile.sessionId, jsonlPath: jsonlPath || 'NONE' });
    let displayName = await this.resolveSessionName(pidFile, jsonlPath);

    if (displayName === pidFile.sessionId.substring(0, 8)) {
      const termName = terminal.name;
      if (termName.startsWith('Claude: ')) {
        displayName = termName.substring(8);
      }
    }

    let tokenUsage: TokenUsage = { contextTokens: 0, cumulativeOutput: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    if (jsonlPath) {
      this.sessionWatcher.watchJsonlFile(pidFile.sessionId, jsonlPath);
      tokenUsage = await this.sessionStorage.scanTokenUsage(jsonlPath);
    }

    let initialStatus: SessionStatus = sessionStatus('none', null);
    if (jsonlPath) {
      const inferred = this.sessionWatcher.inferStatusFromTail(jsonlPath);
      if (inferred) { initialStatus = inferred; }
    }

    this.sessions.set(pidFile.sessionId, {
      sessionId: pidFile.sessionId,
      terminal,
      cwd: pidFile.cwd,
      displayName,
      status: initialStatus,
      pid: pidFile.pid,
      startedAt: pidFile.startedAt,
      version: pidFile.version,
      jsonlPath,
      tokenUsage,
    });
    this._onSessionsChanged.fire();

    if (displayName === pidFile.sessionId.substring(0, 8)) {
      setTimeout(() => this.refreshSessionName(pidFile.sessionId), 3000);
      setTimeout(() => this.refreshSessionName(pidFile.sessionId), 8000);
    }
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
      this.logger.log('rename', 'applied', { sessionId: event.sessionId, from: session.displayName, to: event.newName });
      session.displayName = event.newName;
      this._onSessionsChanged.fire();
    } else {
      this.logger.log('rename', 'no session for id', { sessionId: event.sessionId });
    }
  }

  private handleStatusChanged(event: StatusChangeEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) { return; }
    if (statusEquals(session.status, event.status)) { return; }
    session.status = event.status;
    this._onSessionsChanged.fire();
  }

  private handleTokenUpdate(event: TokenUpdateEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (session) {
      session.tokenUsage.contextTokens = event.latest.contextTokens;
      session.tokenUsage.cumulativeOutput += event.latest.cumulativeOutput;
      session.tokenUsage.cacheReadTokens = event.latest.cacheReadTokens;
      session.tokenUsage.cacheCreateTokens = event.latest.cacheCreateTokens;
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
    if (jsonlPath) {
      try {
        const name = await this.sessionStorage.resolveDisplayName(jsonlPath, '');
        if (name && name !== '(unnamed)') { return name; }
      } catch { /* fall through */ }
    }
    if (pidFile.name) { return pidFile.name; }
    return pidFile.sessionId.substring(0, 8);
  }

  refreshSessionName(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.log('refresh', 'no session', { sessionId });
      return;
    }
    const jsonlPath = session.jsonlPath || this.sessionStorage.findJsonlForSession(sessionId);
    if (jsonlPath && !session.jsonlPath) {
      session.jsonlPath = jsonlPath;
      this.sessionWatcher.watchJsonlFile(sessionId, jsonlPath);
    }
    if (jsonlPath) {
      this.sessionStorage.resolveDisplayName(jsonlPath, '').then(name => {
        this.logger.log('refresh', 'name resolved', { sessionId, current: session.displayName, resolved: name });
        if (name && name !== '(unnamed)' && name !== session.displayName) {
          session.displayName = name;
          this._onSessionsChanged.fire();
        }
      });
    } else {
      this.logger.log('refresh', 'no jsonl path', { sessionId });
    }
  }

  private findJsonlPath(pidFile: SessionPidFile): string | undefined {
    const found = this.sessionStorage.findJsonlForSession(pidFile.sessionId);
    if (found) { return found; }

    if (pidFile.bridgeSessionId) {
      const bridged = this.sessionStorage.findJsonlForSession(pidFile.bridgeSessionId);
      if (bridged) { return bridged; }
    }

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

    // Resumed session fallback: PID's sessionId differs from JSONL filename.
    // Pick the JSONL in the cwd-matching project dir with the latest mtime >= startedAt.
    for (const candidate of candidates) {
      const projDir = path.join(PROJECTS_DIR, candidate);
      let entries: string[];
      try {
        entries = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      let best: { path: string; mtime: number } | null = null;
      for (const f of entries) {
        const fp = path.join(projDir, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtimeMs < pidFile.startedAt - 60_000) { continue; }
          if (!best || st.mtimeMs > best.mtime) { best = { path: fp, mtime: st.mtimeMs }; }
        } catch { continue; }
      }
      if (best) { return best.path; }
    }
    return undefined;
  }

  private pollSessionStatuses(): void {
    const total = this.sessions.size;
    let withPath = 0;
    let changed = 0;
    let resolved = 0;
    for (const [sessionId, session] of this.sessions) {
      if (!session.jsonlPath) {
        const pidFile: SessionPidFile = {
          pid: session.pid,
          sessionId: session.sessionId,
          cwd: session.cwd,
          startedAt: session.startedAt,
          version: session.version,
          kind: 'interactive',
          entrypoint: 'cli',
        };
        const found = this.findJsonlPath(pidFile);
        if (found) {
          this.logger.log('poll', 'jsonl resolved late', { sessionId, jsonlPath: found });
          session.jsonlPath = found;
          this.sessionWatcher.watchJsonlFile(sessionId, found);
          resolved++;
          this.refreshSessionName(sessionId);
        } else {
          continue;
        }
      }
      withPath++;
      const status = this.sessionWatcher.inferStatusFromTail(session.jsonlPath);
      if (!status) { continue; }
      if (statusEquals(session.status, status)) { continue; }
      this.logger.log('poll', 'status changed', { sessionId, from: session.status, to: status });
      session.status = status;
      changed++;
      this._onSessionsChanged.fire();
    }
    this.logger.log('poll', 'cycle', { total, withPath, changed, resolved });
  }

  refreshAllNames(): void {
    this.logger.log('refresh', 'refreshAllNames called', { count: this.sessions.size });
    for (const [sessionId] of this.sessions) {
      this.refreshSessionName(sessionId);
    }
  }

  dispose(): void {
    if (this.statusPollTimer) { clearInterval(this.statusPollTimer); }
    this.disposables.forEach(d => d.dispose());
    this.sessions.clear();
    this.terminalPids.clear();
    this._onSessionsChanged.dispose();
  }
}
