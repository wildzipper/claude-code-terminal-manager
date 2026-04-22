import * as vscode from 'vscode';

export interface TokenUsage {
  contextTokens: number;
  cumulativeOutput: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export type SessionStatusCategory = 'idle' | 'active' | 'unknown';

export type SessionStatus =
  | { category: 'idle'; detail: 'ready' | 'waiting_for_input' }
  | { category: 'active'; detail: 'responding' | 'tool_use' | 'writing' }
  | { category: 'unknown'; detail: 'initializing' | 'stale' };

export function sessionStatus(category: 'idle', detail: 'ready' | 'waiting_for_input'): SessionStatus;
export function sessionStatus(category: 'active', detail: 'responding' | 'tool_use' | 'writing'): SessionStatus;
export function sessionStatus(category: 'unknown', detail: 'initializing' | 'stale'): SessionStatus;
export function sessionStatus(category: SessionStatusCategory, detail: string): SessionStatus {
  return { category, detail } as SessionStatus;
}

export interface ActiveSession {
  sessionId: string;
  terminal: vscode.Terminal;
  cwd: string;
  displayName: string;
  status: SessionStatus;
  pid: number;
  startedAt: number;
  version: string;
  jsonlPath?: string;
  tokenUsage: TokenUsage;
}

export interface PreviousSession {
  sessionId: string;
  projectPath: string;
  displayName: string;
  firstPrompt: string;
  created: string;
  modified: string;
  messageCount: number;
  gitBranch: string;
  jsonlPath: string;
  tokenUsage: TokenUsage;
}

export interface SessionPidFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  version: string;
  kind: string;
  entrypoint: string;
  bridgeSessionId?: string;
  name?: string;
}

export interface SessionsIndex {
  version: number;
  entries: SessionsIndexEntry[];
  originalPath: string;
}

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}
