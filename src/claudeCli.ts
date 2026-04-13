import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function resolveClaudeCliScript(extensionPath: string): string {
  const localCli = path.join(extensionPath, 'resources', 'claude-code', 'cli.js');
  if (fs.existsSync(localCli)) {
    return localCli;
  }

  for (const extensionDir of listClaudeExtensionDirs(path.join(os.homedir(), '.windsurf-server', 'extensions'))) {
    const candidate = path.join(extensionDir, 'resources', 'claude-code', 'cli.js');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(
    process.env.HOME || '',
    '.windsurf-server', 'extensions',
    'anthropic.claude-code-2.1.73-universal',
    'resources', 'claude-code', 'cli.js',
  );
}

function listClaudeExtensionDirs(baseDir: string): string[] {
  try {
    return fs.readdirSync(baseDir)
      .filter(name => name.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map(name => path.join(baseDir, name));
  } catch {
    return [];
  }
}
