import * as vscode from 'vscode';
import * as path from 'path';
import { PreviousSession } from '../types';
import { SessionStorage } from '../services/sessionStorage';

class ProjectGroupItem extends vscode.TreeItem {
  constructor(
    public readonly projectPath: string,
    public readonly sessions: PreviousSession[],
  ) {
    super(path.basename(projectPath) || projectPath, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;
    this.tooltip = projectPath;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'projectGroup';
  }
}

class PreviousSessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: PreviousSession) {
    super(session.displayName, vscode.TreeItemCollapsibleState.None);
    this.description = formatRelativeDate(session.modified);
    this.tooltip = new vscode.MarkdownString(
      `**${session.displayName}**\n\n` +
      `- First prompt: ${session.firstPrompt || '(none)'}\n` +
      `- Messages: ${session.messageCount}\n` +
      `- Branch: ${session.gitBranch || '(none)'}\n` +
      `- Created: ${new Date(session.created).toLocaleDateString()}\n` +
      `- Modified: ${new Date(session.modified).toLocaleDateString()}\n` +
      `- Session: \`${session.sessionId}\``
    );
    this.iconPath = new vscode.ThemeIcon('history');
    this.contextValue = 'previousSession';
    this.command = {
      command: 'claudeTerminalManager.resumeSession',
      title: 'Resume Session',
      arguments: [session],
    };
  }
}

type TreeItem = ProjectGroupItem | PreviousSessionTreeItem;

export class PreviousSessionsProvider implements vscode.TreeDataProvider<TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessionsByProject = new Map<string, PreviousSession[]>();

  constructor(private storage: SessionStorage) {}

  refresh(): void {
    this.storage.invalidateCache();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      const sessions = await this.storage.loadPreviousSessions();
      this.sessionsByProject.clear();
      for (const s of sessions) {
        const key = s.projectPath;
        if (!this.sessionsByProject.has(key)) {
          this.sessionsByProject.set(key, []);
        }
        this.sessionsByProject.get(key)!.push(s);
      }
      const groups = Array.from(this.sessionsByProject.entries())
        .map(([projectPath, sessions]) => new ProjectGroupItem(projectPath, sessions));
      groups.sort((a, b) => {
        const aLatest = Math.max(...a.sessions.map(s => new Date(s.modified).getTime()));
        const bLatest = Math.max(...b.sessions.map(s => new Date(s.modified).getTime()));
        return bLatest - aLatest;
      });
      return groups;
    }

    if (element instanceof ProjectGroupItem) {
      return element.sessions.map(s => new PreviousSessionTreeItem(s));
    }

    return [];
  }
}

function formatRelativeDate(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) { return 'just now'; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  if (diffHours < 24) { return `${diffHours}h ago`; }
  if (diffDays < 30) { return `${diffDays}d ago`; }
  return new Date(isoDate).toLocaleDateString();
}
