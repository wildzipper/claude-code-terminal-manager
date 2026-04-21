import * as vscode from 'vscode';
import * as path from 'path';
import { ActiveSession } from '../types';
import { TerminalTracker } from '../services/terminalTracker';
import { formatTokenCount } from '../utils/format';

export class ActiveSessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: ActiveSession) {
    super(session.displayName, vscode.TreeItemCollapsibleState.None);

    const folder = path.basename(session.cwd);
    const totalTokens = session.tokenUsage.inputTokens + session.tokenUsage.outputTokens;
    const tokenStr = totalTokens > 0 ? ` · ${formatTokenCount(totalTokens)}` : '';
    this.description = `${folder}${tokenStr}`;

    const tu = session.tokenUsage;
    this.tooltip = new vscode.MarkdownString(
      `**${session.displayName}**\n\n` +
      `- Status: ${session.status}\n` +
      `- Folder: ${session.cwd}\n` +
      `- Session: \`${session.sessionId}\`\n` +
      `- PID: ${session.pid}\n` +
      `- Version: ${session.version}\n\n` +
      `**Token Usage**\n` +
      `- Input: ${formatTokenCount(tu.inputTokens)}\n` +
      `- Output: ${formatTokenCount(tu.outputTokens)}\n` +
      `- Cache read: ${formatTokenCount(tu.cacheReadTokens)}\n` +
      `- Cache create: ${formatTokenCount(tu.cacheCreateTokens)}`
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
