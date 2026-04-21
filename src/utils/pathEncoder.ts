import * as path from 'path';

export function encodeProjectPath(fsPath: string): string {
  const normalized = fsPath.replace(/\//g, '\\');
  return normalized
    .replace(/:\\/g, '--')
    .replace(/\\/g, '-')
    .replace(/\./g, '-');
}

export function decodeProjectPath(encoded: string): string {
  const match = encoded.match(/^([a-zA-Z])--(.+)$/);
  if (!match) { return encoded; }
  const drive = match[1];
  const rest = match[2].replace(/-/g, '\\');
  return `${drive}:\\${rest}`;
}

export function getProjectBasename(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}
