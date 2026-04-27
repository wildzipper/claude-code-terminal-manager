import * as vscode from 'vscode';

export class Logger {
  private channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Claude Sessions');
  }

  log(scope: string, message: string, data?: unknown): void {
    const ts = new Date().toISOString().substring(11, 23);
    const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : '';
    this.channel.appendLine(`[${ts}] [${scope}] ${message}${dataStr}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
