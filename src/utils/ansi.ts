const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]].?/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}
