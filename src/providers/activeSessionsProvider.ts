import * as vscode from 'vscode';
import * as path from 'path';
import { ActiveSession } from '../types';
import { TerminalTracker } from '../services/terminalTracker';
import { formatTokenCount } from '../utils/format';

const CONTEXT_LIMIT = 200_000;

export class ActiveSessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: ActiveSession) {
    super(session.displayName, vscode.TreeItemCollapsibleState.None);

    const folder = path.basename(session.cwd);
    const ctx = session.tokenUsage.contextTokens;
    const pct = Math.round((ctx / CONTEXT_LIMIT) * 100);
    const contextStr = ctx > 0 ? ` · ${formatTokenCount(ctx)} (${pct}%)` : '';
    this.description = `${folder}${contextStr}`;

    const tu = session.tokenUsage;
    this.tooltip = new vscode.MarkdownString(
      `**${session.displayName}**\n\n` +
      `- Status: ${session.status}\n` +
      `- Folder: ${session.cwd}\n` +
      `- Session: \`${session.sessionId}\`\n` +
      `- PID: ${session.pid}\n` +
      `- Version: ${session.version}\n\n` +
      `**Context Window**\n` +
      `- Current: ${formatTokenCount(tu.contextTokens)} / 200k (${pct}%)\n` +
      `- Cache read: ${formatTokenCount(tu.cacheReadTokens)}\n` +
      `- Cache create: ${formatTokenCount(tu.cacheCreateTokens)}\n` +
      `- Total output: ${formatTokenCount(tu.cumulativeOutput)}`
    );
    this.iconPath = session.status === 'ready'
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
      : session.status === 'working'
        ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('circle-outline');
    this.contextValue = 'activeSession';
    this.command = {
      command: 'claudeTerminalManager.focusSession',
      title: 'Focus Session',
      arguments: [session.sessionId],
    };
  }
}

export class ActiveSessionsProvider implements vscode.TreeDataProvider<ActiveSessionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private tracker: TerminalTracker) {
    tracker.onSessionsChanged(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ActiveSessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ActiveSessionTreeItem[] {
    return this.tracker.getActiveSessions().map(s => new ActiveSessionTreeItem(s));
  }
}
