import * as vscode from 'vscode';
import { SessionStorage } from './services/sessionStorage';
import { SessionWatcher } from './services/sessionWatcher';
import { TerminalTracker } from './services/terminalTracker';
import { Logger } from './services/logger';
import { ActiveSessionsProvider } from './providers/activeSessionsProvider';
import { PreviousSessionsProvider } from './providers/previousSessionsProvider';
import { PreviousSession } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.log('extension', 'activating');
  const sessionStorage = new SessionStorage();
  const sessionWatcher = new SessionWatcher(logger);
  const terminalTracker = new TerminalTracker(sessionWatcher, sessionStorage, logger);

  const activeProvider = new ActiveSessionsProvider(terminalTracker);
  const previousProvider = new PreviousSessionsProvider(sessionStorage);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('activeSessions', activeProvider),
    vscode.window.registerTreeDataProvider('previousSessions', previousProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminalManager.focusSession', (sessionId: string) => {
      const session = terminalTracker.getSessionBySessionId(sessionId);
      if (session) {
        session.terminal.show(true);
      } else {
        vscode.window.showWarningMessage('Session terminal not found.');
      }
    }),

    vscode.commands.registerCommand('claudeTerminalManager.resumeSession', (prev: PreviousSession) => {
      const terminal = vscode.window.createTerminal({
        name: `Claude: ${prev.displayName}`,
        cwd: prev.projectPath,
      });
      terminal.show();
      terminal.sendText(`claude --resume ${prev.sessionId}`);
    }),

    vscode.commands.registerCommand('claudeTerminalManager.newSession', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const terminal = vscode.window.createTerminal({
        name: 'Claude: New Session',
        ...(cwd ? { cwd } : {}),
      });
      terminal.show();
      terminal.sendText('claude');
    }),

    vscode.commands.registerCommand('claudeTerminalManager.refresh', () => {
      terminalTracker.refreshAllNames();
      activeProvider.refresh();
      previousProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeTerminalManager.showLogs', () => {
      logger.show();
    }),

    vscode.commands.registerCommand('claudeTerminalManager.copySessionId', (item: { session?: { sessionId: string } }) => {
      const sessionId = item?.session?.sessionId;
      if (sessionId) {
        vscode.env.clipboard.writeText(sessionId);
        vscode.window.showInformationMessage(`Copied session ID: ${sessionId}`);
      }
    }),
  );

  sessionWatcher.start();
  terminalTracker.start();

  const refreshInterval = setInterval(() => {
    previousProvider.refresh();
  }, 30_000);

  context.subscriptions.push(
    sessionWatcher,
    terminalTracker,
    logger,
    { dispose: () => clearInterval(refreshInterval) },
  );
}

export function deactivate(): void {}
