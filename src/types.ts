import * as vscode from 'vscode';

export interface ActiveSession {
  sessionId: string;
  terminal: vscode.Terminal;
  cwd: string;
  displayName: string;
  status: 'ready' | 'working' | 'unknown';
  pid: number;
  startedAt: number;
  version: string;
  jsonlPath?: string;
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
