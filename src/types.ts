import * as vscode from 'vscode';

export interface TokenUsage {
  contextTokens: number;
  cumulativeOutput: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface SessionStatus {
  type: string;
  qualifier: string | null;
  isError?: boolean;
}

export function sessionStatus(type: string, qualifier: string | null, isError?: boolean): SessionStatus {
  return isError ? { type, qualifier, isError } : { type, qualifier };
}

export function statusEquals(a: SessionStatus, b: SessionStatus): boolean {
  return a.type === b.type && a.qualifier === b.qualifier && !!a.isError === !!b.isError;
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
